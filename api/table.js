import { publicUserDbs, onDatabaseChange } from '../db/index.js'
import { constructEntryUrl } from '../lib/strings.js'
import { fetchUserId } from '../lib/network.js'
import * as errors from '../lib/errors.js'

export function setup (wsServer) {
  wsServer.register('table.list', async ([databaseId, schemaId, opts], client) => {
    const {db, table} = await load(databaseId, schemaId)
    const entries = await table.list(getListOpts(opts))
    for (let entry of entries) {
      entry.url = constructEntryUrl(db.url, schemaId, entry.key)
    }
    return {entries}
  })

  wsServer.register('table.get', async ([databaseId, schemaId, key], client) => {
    const {db, table} = await load(databaseId, schemaId)
    const entry = await table.get(key)
    if (entry) {
      entry.url = constructEntryUrl(db.url, schemaId, entry.key)
    }
    return entry
  })

  wsServer.register('table.insert', async ([databaseId, schemaId, value], client) => {
    const {db, table} = await load(databaseId, schemaId)

    const key = table.schema.generateKey(value)
    await table.put(key, value)
    await onDatabaseChange(db)

    const url = constructEntryUrl(db.url, schemaId, key)
    return {key, url}
  })

  wsServer.register('table.update', async ([databaseId, schemaId, key, value], client) => {
    const {db, table} = await load(databaseId, schemaId)
    
    const release = await table.lock(key)
    try {
      const entry = await table.get(key)
      if (!entry) {
        throw new errors.NotFoundError()
      }
      
      await table.put(key, value)
      await onDatabaseChange(db)

      const url = constructEntryUrl(db.url, schemaId, key)
      return {key, url}
    } finally {
      release()
    }
  })

  wsServer.register('table.del', async ([databaseId, schemaId, key], client) => {
    const {db, table} = await load(databaseId, schemaId)

    const release = await table.lock(key)
    try {
      await table.del(key)
      await onDatabaseChange(db)
    } finally {
      release()
    }
  })
}

async function load (databaseId, schemaId) {
  databaseId = await fetchUserId(databaseId)
  const db = getDb(databaseId)
  const table = db.tables[schemaId]
  if (!table) throw new Error(`Table "${schemaId}" not found`)
  return {db, table, databaseId}
}

function getListOpts (listOpts = {}) {
  const opts = {}
  if (typeof listOpts.limit === 'number') opts.limit = listOpts.limit
  if (typeof listOpts.lt === 'string') opts.lt = listOpts.lt
  if (typeof listOpts.lte === 'string') opts.lte = listOpts.lte
  if (typeof listOpts.gt === 'string') opts.gt = listOpts.gt
  if (typeof listOpts.gte === 'string') opts.gte = listOpts.gte
  if (listOpts.reverse) opts.reverse = true
  return opts
}

function getDb (userId) {
  const publicUserDb = publicUserDbs.get(userId)
  if (!publicUserDb) throw new Error(`User database "${userId}" not found`)
  return publicUserDb
}