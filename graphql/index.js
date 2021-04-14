// https://www.howtographql.com/graphql-js/2-a-simple-query/
import { ApolloServer, PubSub } from 'apollo-server'
import { Config } from '../lib/config.js'
import * as db from '../db/index.js'

import { setOrigin, getDomain, constructUserId, constructUserUrl, parseUserId } from '../lib/strings.js'

import {resolvers} from './resolvers.js'
import {sessionInfoFromRecord} from './util.js'
import fs from 'fs'



async function getSessionInfo(authHeader) {
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



const typeDefs = fs.readFileSync("./graphql/schema.graphql", 'utf8')
// resolvers are async (parent, args, context, info)

// for local testing without booting up the whole ctzn server
async function testSetup() {
    let config = new Config({ configDir: "./config" })
    config.read()
    Config.setActiveConfig(config)
    setOrigin(`http://${config.domain || 'localhost'}:${config.port}`)

    await db.setup(config)
    await setup()
}

// 3
export async function setup({ graphqlPort }) {

    const pubsub = new PubSub()
    async function context({ req }) {
        return {
            ...req,
            pubsub,
            sessionInfo:
                req && req.headers.authorization
                    ? await getSessionInfo(req.headers.authorization)
                    : null
        };
    }
    const server = new ApolloServer({ typeDefs, resolvers, context })

    server.listen({ port: graphqlPort || 4005 })
        .then(({ url }) =>
            console.log(`GraphQL Server is running on ${url}`)
        )
}