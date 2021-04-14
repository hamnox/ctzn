import { getDomain, constructUserId, constructUserUrl } from '../lib/strings.js'
import { verifyPassword } from '../lib/crypto.js'
import * as errors from '../lib/errors.js'

import * as db from '../db/index.js'
import { v4 as uuidv4 } from 'uuid'

export function userToUserRef({ key, value }) {
    return {
        username: value.username,
        userId: constructUserId(value.username),
        domain: getDomain(),
        dbUrl: value.dbUrl,
        joinDate: value.joinDate
    }

}

export async function sessionInfoFromRecord(record) {
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
