import EventEmitter from 'events'
import _debounce from 'lodash.debounce'
import { client } from './hyperspace.js'
import Hyperbee from 'hyperbee'
import * as schemas from '../lib/schemas.js'
import pump from 'pump'
import concat from 'concat-stream'
import through2 from 'through2'
import bytes from 'bytes'
import { catchupIndexes, getAllDbs } from './index.js'
import dbmethods from './dbmethods.js'
import lock from '../lib/lock.js'
import * as perf from '../lib/perf.js'
import * as issues from '../lib/issues.js'
import { ValidationError } from '../lib/errors.js'
import { constructEntryUrl } from '../lib/strings.js'
import { DbIndexingIssue } from '../lib/issues/db-indexing.js'
import { DbmethodBadResponse } from '../lib/issues/dbmethod-bad-response.js'

const FIRST_HYPERBEE_BLOCK = 2
const READ_TIMEOUT = 10e3
const BACKGROUND_INDEXING_DELAY = 5e3 // how much time is allowed to pass before globally indexing an update
const BLOB_CHUNK_SIZE = bytes('64kb')

const dbDescription = schemas.createValidator({
  type: 'object',
  properties: {
    dbType: {
      type: 'string'
    },
    blobsFeedKey: {
      type: 'string',
      pattern: "^[a-f0-9]{64}$"
    }
  }
})

const blobPointer = schemas.createValidator({
  type: 'object',
  properties: {
    start: {type: 'number'},
    end: {type: 'number'},
    mimeType: {type: 'string'}
  }
})

export class BaseHyperbeeDB extends EventEmitter {
  constructor (_ident, key, {isPrivate} = {isPrivate: false}) {
    super()
    if (typeof key === 'string') {
      key = Buffer.from(key, 'hex')
    }
    this._ident = _ident
    this.isPrivate = isPrivate
    this.desc = undefined
    this.key = key || null
    this.bee = null
    this.blobs = new Blobs(this, {isPrivate})
    this.tables = {}
    this.indexers = []
    this.dbmethods = {}
    this.lock = (id = '') => lock(`${this.key.toString('hex')}:${id}`)
  }

  get dbType () {
    throw new Error('Must be overridden')
    return ''
  }

  get supportedMethods () {
    return []
  }

  get writable () {
    return this.bee?.feed?.writable
  }

  get peers () {
    return this.bee?.feed?.peers
  }

  get url () {
    return `hyper://${this.key.toString('hex')}/`
  }

  async setup () {
    this.bee = new Hyperbee(client.corestore().get(this.key), {
      keyEncoding: 'utf8',
      valueEncoding: 'json'
    })
    await this.bee.ready()
    if (!this.isPrivate) {
      client.replicate(this.bee.feed)
    }

    if (!this.bee.feed.writable) {
      this._eagerUpdate()
    }

    if (!this.key) {
      this.key = this.bee.feed.key
      await this.updateDesc()
      this.onDatabaseCreated()
    }

    const desc = await this.bee.get('_db', {timeout: READ_TIMEOUT})
    if (desc) {
      dbDescription.assert(desc.value)
      this.desc = desc.value
    } else {
      this.desc = {
        blobsFeedKey: null
      }
    }

    this.dbmethodCalls = this.getTable('ctzn.network/dbmethod-call')
    this.dbmethodResults = this.getTable('ctzn.network/dbmethod-result')
    this.dbmethodResultsChronIdx = this.getTable('ctzn.network/dbmethod-result-chron-idx')
    if (this.writable) {
      for (let method of this.supportedMethods) {
        this.createDbMethod(`ctzn.network/${method}-method`, dbmethods[method])
      }
    }
  }

  async teardown () {
    if (this.blobs) await this.blobs.teardown()
    this.blobs = undefined
    if (!this.isPrivate) {
      client.network.configure(this.bee.feed, {announce: false, lookup: false})
    }
    await this.bee.feed.close()
    this.bee = undefined
  }

  async updateDesc (updates) {
    this.desc = this.desc || {}
    if (updates) {
      for (let k in updates) {
        this.desc[k] = updates[k]
      }
    }
    this.desc.dbType = this.dbType
    dbDescription.assert(this.desc)
    await this.bee.put('_db', this.desc)
  }

  async onDatabaseCreated () {
  }

  async whenSynced () {
    if (!this.bee.feed.writable) {
      const pend = perf.measure('whenSynced')
      await this.bee.feed.update({ifAvailable: true}).catch(e => undefined)
      pend()
    }
  }

  watch (_cb) {
    const cb = _debounce(() => _cb(this), BACKGROUND_INDEXING_DELAY, {trailing: true})
    this.bee.feed.on('append', () => cb())
  }

  async _eagerUpdate () {
    if (!this.bee) return
    await this.bee.feed.update({ifAvailable: false}).catch(e => undefined)
    this._eagerUpdate()
  }

  getTable (schemaId) {
    if (this.tables[schemaId]) return this.tables[schemaId]
    let schema = schemas.get(schemaId)
    if (!schema) throw new Error(`Unsupported table schema: ${schemaId}`)
    this.tables[schemaId] = new Table(this, schema)
    return this.tables[schemaId]
  }

  async getSubscribedDbUrls () {
    // override in subclasses to
    // give a list of URLs for databases currently watched by this database for changes
    return []
  }

  createIndexer (schemaId, targetSchemaIds, indexFn) {
    if (!this.writable) return
    this.indexers.push(new Indexer(this, schemaId, targetSchemaIds, indexFn))
  }

  createDbMethod (methodId, handler) {
    if (!this.writable) return
    let schema = schemas.get(methodId)
    this.dbmethods[methodId] = new DbMethod(this, methodId, schema, handler)
  }

  async lockAllIndexes () {
    const releases = await Promise.all(Array.from(getAllDbs(), db => this.lock(`update-indexes:${db.url}`)))
    return () => {
      releases.forEach(release => release())
    }
  }

  async rebuildIndexes (indexIds = undefined) {
    if (!this.key || !this.writable) return
    console.log('Rebuilding', indexIds ? `indexes: ${indexIds.join(', ')}` : 'all indexes of', this._ident)
    const release = await this.lockAllIndexes()
    try {
      for (let indexer of this.indexers) {
        if (indexIds && !indexIds.includes(indexer.schemaId)) {
          continue
        }
        const idxTable = this.getTable(indexer.schemaId)
        const entries = await idxTable.list()
        for (let entry of entries) {
          await idxTable.del(entry.key)
        }
        await indexer.clearAllState()
      }
      console.log('Cleared indexes of', this._ident, '- now triggering rebuild')
    } catch (e) {
      console.error('Failed to rebuild indexes of', this._ident)
      console.error(e)
      throw e
    } finally {
      release()
    }
    catchupIndexes(this)
  }

  async updateIndexes ({changedDb}) {
    if (!this.key || !this.writable) return
    const release = await this.lock(`update-indexes:${changedDb.url}`)

    const batch = this.bee.batch()
    try {
      const indexStates = await Promise.all(this.indexers.map(i => i.getState(changedDb.url)))
      for (let i = 0; i < this.indexers.length; i++) {
        const indexer = this.indexers[i]
        const indexState = indexStates[i]
        let start = indexState?.value?.subject?.lastIndexedSeq || FIRST_HYPERBEE_BLOCK
        if (start === changedDb.bee.version) continue

        // console.log('Calling diff for', indexer.schemaId)
        // console.log('Indexing DB:', this._ident)
        // console.log('Changed DB:', changedDb._ident)
        // console.log('Tables:', indexer.targetSchemaIds)
        // console.log('Start:', start)
        // console.log('Current version:', changedDb.bee.version)
        const diffLists = await Promise.all(indexer.targetSchemaIds.map(schemaId =>
          changedDb.getTable(schemaId).listDiff(start)
        ))

        const diffs = []
        for (let j = 0; j < indexer.targetSchemaIds.length; j++) {
          const tableSchemaId = indexer.targetSchemaIds[j]
          for (let diff of diffLists[j]) {
            if (diff.left) {
              diff.left.schemaId = tableSchemaId
              diff.left.url = constructEntryUrl(changedDb.url, tableSchemaId, diff.left.key)
            }
            if (diff.right) {
              diff.right.schemaId = tableSchemaId
              diff.right.url = constructEntryUrl(changedDb.url, tableSchemaId, diff.right.key)
            }
            diffs.push(diff)
          }
        }
        diffs.sort((a, b) => {
          let aSeq = a.right?.seq || a.left?.seq || FIRST_HYPERBEE_BLOCK
          let bSeq = b.right?.seq || b.left?.seq || FIRST_HYPERBEE_BLOCK
          return aSeq - bSeq
        })
        // console.log(diffs)

        if (diffs.length === 0) {
          continue
        }

        for (let diff of diffs) {
          try {
            await indexer.index(batch, changedDb, diff)
          } catch (e) {
            issues.add(new DbIndexingIssue({
              error: e,
              changedDb,
              diff,
              indexingDb: this,
              indexer
            }))
          }
        }
        await indexer.updateState(batch, changedDb.url, changedDb.bee.version)
      }
      await batch.flush()
    } finally {
      release()
    }
  }
}

class Blobs {
  constructor (db, {isPrivate}) {
    this.db = db
    this.kv = undefined
    this.feed = undefined
    this.isPrivate = isPrivate
  }

  get writable () {
    return this.feed?.writable
  }

  get peers () {
    return this.feed?.peers
  }

  async setup () {
    this.kv = this.db.bee.sub('_blobs')

    if (!this.db.desc.blobsFeedKey) {
      this.feed = client.corestore().get(null)
      await this.feed.ready()
      await this.db.updateDesc({
        blobsFeedKey: this.feed.key.toString('hex')
      })
    } else {
      this.feed = client.corestore().get(Buffer.from(this.db.desc.blobsFeedKey, 'hex'))
      await this.feed.ready()
    }
    if (!this.isPrivate) {
      client.replicate(this.feed)
    }

    // TODO track which ranges in the feed are actively pointed to and cache/decache accordingly
  }

  async teardown () {
    if (!this.feed) return
    if (!this.isPrivate) {
      client.network.configure(this.feed, {announce: false, lookup: false})
    }
    await this.feed.close()
  }

  async getPointer (key) {
    const pointer = await this.kv.get(key, {timeout: READ_TIMEOUT})
    if (!pointer) throw new Error('Blob not found')
    blobPointer.assert(pointer.value)
    return pointer.value
  }

  async createReadStream (key) {
    const pointer = await this.kv.get(key, {timeout: READ_TIMEOUT})
    if (!pointer) throw new Error('Blob not found')
    blobPointer.assert(pointer.value)
    return this.feed.createReadStream({
      start: pointer.value.start,
      end: pointer.value.end,
      timeout: READ_TIMEOUT
    })
  }

  async get (key, encoding = undefined) {
    const ptr = await this.getPointer(key)
    const stream = await this.createReadStreamFromPointer(ptr)
    return new Promise((resolve, reject) => {
      pump(
        stream,
        concat({encoding: 'buffer'}, buf => {
          resolve({
            mimeType: ptr.mimeType,
            buf: encoding && encoding !== 'buffer' ? buf.toString(encoding) : buf
          })
        }),
        reject
      )
    })
  }

  async createReadStreamFromPointer (pointer) {
    return this.feed.createReadStream({
      start: pointer.start,
      end: pointer.end,
      timeout: READ_TIMEOUT
    })
  }

  async put (key, buf, {mimeType} = {mimeType: undefined}) {
    const chunks = chunkify(buf, BLOB_CHUNK_SIZE)
    const start = await this.feed.append(chunks)
    const pointer = {start, end: start + chunks.length, mimeType}
    blobPointer.assert(pointer)
    await this.kv.put(key, pointer)
  }
}

class Table {
  constructor (db, schema) {
    const [domain, name] = schema.id.split('/')
    this.db = db
    this.bee = this.db.bee.sub(domain).sub(name)
    this.schema = schema
    this._schemaDomain = domain
    this._schemaName = name
    this._onPutCbs = undefined
    this._onDelCbs = undefined
    this.lock = (id = '') => this.db.lock(`${this.schema.id}:${id}`)
  }

  constructBeeKey (key) {
    return this.bee.keyEncoding.encode(key)
  }

  constructEntryUrl (key) {
    return constructEntryUrl(this.db.url, this.schema.id, key)
  }

  async get (key) {
    const pend = perf.measure('table.get')
    let entry = await this.bee.get(String(key), {timeout: READ_TIMEOUT})
    if (entry) {
      this.schema.assertValid(entry.value)
    }
    pend()
    return entry
  }

  async put (key, value) {
    const pend = perf.measure('table.put')
    this.schema.assertValid(value)
    const res = await this.bee.put(String(key), value)
    pend()
    if (this._onPutCbs) {
      this._onPutCbs.forEach(cb => cb(key, value))
    }
    return res
  }

  async del (key) {
    const pend = perf.measure('table.del')
    const res = await this.bee.del(String(key))
    pend()
    if (this._onDelCbs) {
      this._onDelCbs.forEach(cb => cb(key))
    }
    return res
  }

  createReadStream (opts) {
    let _this = this
    opts = opts || {}
    opts.timeout = READ_TIMEOUT
    return this.bee.createReadStream(opts).pipe(through2.obj(function (entry, enc, cb) {
      const valid = _this.schema.validate(entry.value)
      if (valid) this.push(entry)
      cb()
    }))
  }

  async list (opts) {
    const pend = perf.measure('table.list')
    opts = opts || {}
    opts.timeout = READ_TIMEOUT
    return new Promise((resolve, reject) => {
      pump(
        this.createReadStream(opts),
        concat(resolve),
        err => {
          pend()
          if (err) reject(err)
        }
      )
    })
  }

  scanFind (opts, fn) {
    return new Promise((resolve, reject) => {
      let found = false
      opts = opts || {}
      opts.timeout = READ_TIMEOUT
      const rs = this.createReadStream(opts)
      rs.on('data', entry => {
        if (found) return
        if (fn(entry)) {
          // TODO fix rs.destroy()
          // rs.destroy()
          found = true
          resolve(entry)
        }
      })
      rs.on('end', () => {
        if (!found) resolve(undefined)
      })
    })
  }

  cursorRead (opts = {}) {
    let lt = opts.lt
    let atEnd = false
    return {
      opts,
      db: this.db,
      next: async (n) => {
        if (atEnd) return null
        let res = await this.list(Object.assign({}, opts, {lt, limit: n}))
        if (res.length === 0) {
          atEnd = true
          return null
        }
        lt = res[res.length - 1].key
        return res
      }
    }
  }

  onPut (cb) {
    this._onPutCbs = this._onPutCbs || []
    this._onPutCbs.push(cb)
  }

  onDel (cb) {
    this._onDelCbs = this._onDelCbs || []
    this._onDelCbs.push(cb)
  }

  async listDiff (other, opts) {
    const pend = perf.measure('table.listDiff')
    opts = opts || {}
    opts.timeout = READ_TIMEOUT
    /**
     * HACK
     * There's a bug in Hyperbee where createDiffStream() breaks on sub()s.
     * We have to run it without using sub() and then filter the results.
     * -prf
     */
    // const co = this.db.bee.checkout(other).sub(this._schemaDomain).sub(this._schemaName)
    // return new Promise((resolve, reject) => {
    //   pump(
    //     co.createDiffStream(this.bee.version),
    //     concat(resolve),
    //     err => {
    //       pend()
    //       if (err) reject(err)
    //     }
    //   )
    // })
    const co = this.db.bee.checkout(other)
    const diffs = await new Promise((resolve, reject) => {
      pump(
        co.createDiffStream(this.bee.version),
        concat(resolve),
        err => {
          pend()
          if (err) reject(err)
        }
      )
    })
    const prefix = `${this._schemaDomain}\x00${this._schemaName}\x00`
    return diffs.filter(diff => {
      const key = (diff.right||diff.left).key
      if (key.startsWith(prefix)) {
        if (diff.left) diff.left.key = diff.left.key.slice(prefix.length)
        if (diff.right) diff.right.key = diff.right.key.slice(prefix.length)
        return true
      }
      return false
    })
  }
}

class DbMethod {
  constructor (db, methodId, schema, handler) {
    this.db = db
    this.methodId = methodId
    this.schema = schema
    this.handler = handler
  }

  validateCallArgs (args) {
    if (this.schema.validateParams) {
      const valid = this.schema.validateParams(args)
      if (!valid) {
        throw new ValidationError(this.schema.validateParams.errors[0])
      }
    }
  }

  validateResponse (res) {
    if (this.schema.validate) {
      const valid = this.schema.validate(res)
      if (!valid) {
        issues.add(new DbmethodBadResponse({
          error: JSON.stringify(this.schema.validate.errors[0], null, 2),
          handlingDb: this.db,
          method: this.methodId
        }))
      }
    }
  }
}

class Indexer {
  constructor (db, schemaId, targetSchemaIds, indexFn) {
    this.db = db
    this.schemaId = schemaId
    this.targetSchemaIds = targetSchemaIds
    this.index = indexFn
    this.indexStatesCache = {}
  }

  async getState (url) {
    if (!this.indexStatesCache[url] && !this.schemaId.startsWith('memory:')) {
      this.indexStatesCache[url] = await this.db.indexState.get(`${this.schemaId}:${url}`, {timeout: READ_TIMEOUT})
    }
    return this.indexStatesCache[url]
  }

  async updateState (batch, url, seq) {
    this.indexStatesCache[url] = {
      value: {
        schemaId: this.schemaId,
        subject: {dbUrl: url, lastIndexedSeq: seq},
        updatedAt: (new Date()).toISOString()
      }
    }
    if (this.schemaId.startsWith('memory:')) return
    await batch.put(
      this.db.indexState.constructBeeKey(`${this.schemaId}:${url}`),
      this.indexStatesCache[url].value
    )
  }

  async clearAllState () {
    if (!this.schemaId.startsWith('memory:')) {
      const states = await this.db.indexState.list({
        gte: `${this.schemaId}:\x00`,
        lte: `${this.schemaId}:\xff`
      })
      for (let state of states) {
        await this.db.indexState.del(state.key)
      }
    }
    this.indexStatesCache = {}
  }

  isInterestedIn (schemaId) {
    return this.targetSchemaIds.includes(schemaId)
  }
}

function chunkify (buf, chunkSize) {
  const chunks = []
  while (buf.length) {
    chunks.push(buf.slice(0, chunkSize))
    buf = buf.slice(chunkSize)
  }
  return chunks
}

const _debouncers = {}
function getDebouncedFn (key, fn, wait) {
  if (!_debouncers[key]) {
    _debouncers[key] = _debounce(fn, wait)
  }
  return _debouncers[key]
}