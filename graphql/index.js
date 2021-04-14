// https://www.howtographql.com/graphql-js/2-a-simple-query/
import { ApolloServer } from 'apollo-server'
import { Config } from '../lib/config.js'
import * as db from '../db/index.js'

import { setOrigin, getDomain, constructUserId, constructUserUrl, parseUserId } from '../lib/strings.js'

import * as r from './resolvers.js'
import {userToUserRef} from './util.js'

import fs from 'fs'
import path from 'path'





async function context({ req }) {
    return {
        ...req,
        sessionInfo:
            req && req.headers.authorization
                ? await r.getSessionInfo(req.headers.authorization)
                : null
    };
}

const typeDefs = fs.readFileSync("./graphql/schema.graphql", 'utf8')
// resolvers are async (parent, args, context, info)
const resolvers = {
    Query: {
        users: async () => {
            const userlist = await db.publicServerDb.users.list()
            return userlist.map(userToUserRef)
        },
        sessionInfo: async (parent, args, context) => {
            return context.sessionInfo
        }
    },
    UserRef: r.userRefResolver,
    Mutation: {
        login: r.login,
        signup: r.signup
    }
}

async function testSetup() {
    let config = new Config({ configDir: "./config" })
    config.read()
    Config.setActiveConfig(config)
    setOrigin(`http://${config.domain || 'localhost'}:${config.port}`)

    await db.setup(config)
    await setup()
}

// 3
export async function setup(config) {
    const server = new ApolloServer({ typeDefs, resolvers, context })
    server.listen({ port: 4005 })
        .then(({ url }) =>
            console.log(`Server is running on ${url}`)
        )
}
