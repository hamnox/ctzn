import * as errors from '../lib/errors.js'
import * as db from '../db/index.js'
import { createValidator } from '../lib/schemas.js'

import { getDomain, constructUserId, constructUserUrl, parseUserId } from '../lib/strings.js'
import { verifyPassword } from '../lib/crypto.js'

import { v4 as uuidv4 } from 'uuid'

export const userRefResolver = {
    userId: ({userId, username, domain, dbUrl}) => {
        if (userId) return userId
        if (username && domain) return `${username}@${domain}`
        if (dbUrl) {
            let userDb = db.getDbByUrl(dbUrl)
            return userDb?.userId
        }
        throw new Error('userId not found')
    },
    username: ({username, userId}) => {
        if (username) return username
        if (userId) return parseUserId(userId).username
        throw new Error('username not found')
    },
    domain: ({domain, userId}) => domain || parseUserId(userId).domain,
    dbUrl: ({userId, dbUrl}) => {
        if (dbUrl) return dbUrl
        if (userId) return db.publicDbs.get(userId)
        throw new Error('dbUrl not found')
    }
}

const registerParam = createValidator({
    type: 'object',
    required: ['username', 'displayName'],
    additionalProperties: false,
    properties: {
        username: { type: 'string', pattern: "^([a-zA-Z][a-zA-Z0-9-]{1,62}[a-zA-Z0-9])$" },
        email: { type: 'string', format: "email" },
        password: { type: 'string', minLength: 1 },
        displayName: { type: 'string', minLength: 1, maxLength: 64 },
        description: { type: 'string', maxLength: 256 }
    }
})

export async function signup(parent, info, context) {
    info = info || {}
    registerParam.assert(info)

    const citizenUser = await db.createUser({
        type: 'citizen',
        username: info.username,
        email: info.email,
        password: info.password,
        profile: {
            displayName: info.displayName,
            description: info.description
        }
    })

    const username = info.username
    const userId = constructUserId(username)
    const dbUrl = citizenUser.publicDb.url
    const sess = await createSession(context, { username, userId, dbUrl })
    return sess


}
async function sessionInfoFromRecord(record) {
    const username = record.value.username
    const user = await db.publicServerDb.users.get(username)
    if (!user) {
        throw new errors.NotFoundError('User not found')
    }
    return {
        sessionId: record.value.sessionId,
        userRef: {
            userId: constructUserId(username),
            dbUrl: user.value.dbUrl,
        },
        createdAt: record.value.createdAt
    }
}

export async function getSessionInfo(authHeader) {
    let sessionId
    if (authHeader) {
        sessionId = authHeader.replace('token ', '').replace('Bearer ', '')
    }
    if (!sessionId) {
        return null
    }
    const record = await db.privateServerDb.accountSessions.get(sessionId)
    if (record) {
        return sessionInfoFromRecord(record)
    }
    return null
}


export async function login(parent, { username, password }, context) {
    const accountRecord = await db.privateServerDb.accounts.get(username)
    if (!accountRecord || !(await verifyPassword(password, accountRecord.value.hashedPassword))) {
        return
    }

    if (context.sessionInfo) return context.sessionInfo
    const user = await db.publicServerDb.users.get(username)
    if (!user) {
        throw new errors.NotFoundError('User not found')
    }

    const auth = await createSession(context, { username, userId: constructUserId(username), dbUrl: user.value.dbUrl })
    return auth
}

async function createSession(context, { username, userId, dbUrl }) {
    const sess = {
        sessionId: uuidv4(),
        username,
        createdAt: (new Date()).toISOString()
    }
    await db.privateServerDb.accountSessions.put(sess.sessionId, sess)

    context.auth = {
        sessionId: sess.sessionId,
        userRef: {
            dbUrl,
            userId
        },
        createdAt: sess.createdAt
    }

    return context.auth
}
