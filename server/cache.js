'use strict'

const fs = require('fs')

const request = require('request')
const async = require('async')

const log = require('./logger')

const cache = {} // simple path to html cache
const byId = {} // id to last modified + paths
const noCache = {} // paths not to cache, mapped to timeouts of when they can be cached again
let instances = [] // the IPs of all the other library instances
let kubeToken = null // store the kube token here after we read it
startInstancePolling()

// delay caching for 1 hour by default after editing, with env var override
const noCacheDelay = parseInt(process.env.EDIT_CACHE_DELAY, 10) || 60 * 60
// how long to wait before refreshing kube ip lists for cache purge
const instanceUpdateDelay = parseInt(process.env.INSTANCE_UPDATE_DELAY, 10) || 5 * 60

// detects purge requests and serves cached responses when available
exports.middleware = (req, res, next) => {
  const cachedHTML = cache[req.path]

  const {purge, edit, recurse} = req.query
  if (purge || edit) {
    return purgeCache(req.path, edit, recurse, (err) => {
      if (err) {
        log.warn(`Cache purge failed for ${req.path}`, err)
        // if we failed, we should probably update the instance list
        if (kubeToken) updateInstances(kubeToken)
        return res.status(500).send(err)
      }

      log.info(`Cache purge complete for ${req.path}.`)
      res.end('OK')
    })
  } // deletes cache for a particular route

  if (cachedHTML) {
    log.info(`CACHE HIT ${req.path}.`)
    return res.end(cachedHTML)
  }

  next()
}

exports.add = (id, modified, path, html) => {
  if (!modified) return // refused to add anything without a modified timestamp

  if (noCache[path]) return // refuse to cache any items that are being edited

  cache[path] = html
  const data = byId[id] || {paths: new Set(), modified}
  data.paths.add(path)

  byId[id] = data
}

// purge assets by id and their modified times
exports.purge = (id, newModified) => {
  const data = byId[id]
  if (!data) return
  // skip purging items which have not changed
  if (data.modified === newModified) return

  data.paths.forEach((path) => {
    const segments = path.split('/').map((segment, i, segments) => {
      return segments.slice(0, i).concat([segment]).join('/')
    })

    // don't just purge the top path, purge all the parents too.
    // no recursion here since other instances will determine themselves when pages have expired
    segments.forEach((url) => {
      if (!cache[url]) return
      log.info(`Changes at ${path}; purging local cache for ${url}.`)
      purgeCache(url)
    })
  })
}

function startInstancePolling() {
  try {
    kubeToken = fs.readFileSync('***REMOVED***', 'utf8')
  } catch (e) {
    return log.warn('No kubernetes No token file so will not produce an instance list.')
  }

  // 5 min default delay with env override
  const poll = () => {
    updateInstances(kubeToken, (err, ips) => {
      if (err) {
        log.warn('Got error while attempting to update instance IPs:', err)
      } else {
        log.debug('Instance IP list updated.', ips)
      }

      // after some delay, update again.
      setTimeout(poll, instanceUpdateDelay * 1000)
    })
  }

  setTimeout(poll, 90 * 1000) // wait 90s after deploy, not configurable
}

function updateInstances(token, cb = () => {}) {
  request.get({
    url: '***REMOVED***',
    rejectUnauthorized: false,
    qs: {
      labelSelector: 'app=nyt-library'
    },
    auth: {
      bearer: token
    },
    json: true
  }, (err, res, body) => {
    if (err) {
      return cb(err)
    }

    if (res.statusCode !== 200) {
      return cb(Error(`Got status ${res.statusCode}; expected 200 while updating instance list.`))
    }

    // pull off all the pod IPs
    instances = body.items.map((i) => i.status.podIP)
    cb(null, instances)
  })
}

function purgeCache(path, preventCache, recurse, cb) {
  if (recurse) {
    // rather than try to delete our cache directly, purge all instances
    // we don't know what IP we are on
    return async.each(instances, (instance, cb) => {
      const qs = {
        purge: 1
      }

      // if we are setting a timeout, pass that along with the request
      if (preventCache) qs.edit = 1

      const url = `http://${instance}:3000${path}`
      request.get({
        url,
        qs
      }, (err, res, body) => {
        if (err) return cb(err)

        if (res.statusCode !== 200) {
          err = Error(`Tried to purge ${url} but received ${res.statusCode}; expected 200.`)
          log.err(err)
          return cb(err)
        }

        log.info(`Purged cache @ ${url}`)
        cb(null, body)
      })
    }, cb)
  }

  if (preventCache) {
    log.info(`Preventing cache of ${path} for next hour.`)
    const existingTimer = noCache[path]
    if (existingTimer) clearTimeout(existingTimer)
    noCache[path] = setTimeout(() => delete noCache[path], noCacheDelay * 1000) // 1 hr
  }

  // if this is specifically to just purge on this node, don't make requests elsewhere
  log.debug(`Purging local cache of ${path}.`)
  delete cache[path]
  if (cb) cb(null)
}