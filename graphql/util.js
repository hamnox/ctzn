import { getDomain, constructUserId, constructUserUrl } from '../lib/strings.js'
import { verifyPassword } from '../lib/crypto.js'

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