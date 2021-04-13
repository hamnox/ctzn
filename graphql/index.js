// https://www.howtographql.com/graphql-js/2-a-simple-query/
import * as db from '../db/index.js'
import { Config } from '../lib/config.js'
import { getDomain, constructUserId } from '../lib/strings.js'

import { ApolloServer, gql } from 'apollo-server'
import { debugGetLastEmail } from '../lib/email.js'

// 1
const typeDefs = gql`
    type Query {
        users: [UserRef]
    }

    type UserRef {
        username: String!
        domain: String!
        userId: String!
        dbUrl: String!
        joinDate: String!
    }
`

// 2

function userToUserRef({key, value}) {
    return {
        username: value.username,
        userId: constructUserId(value.username),
        domain: getDomain(),
        dbUrl: value.dbUrl,
        joinDate: value.joinDate
    }

}

const resolvers = {
    Query: {
        users: async () => {
            const userlist = await db.publicServerDb.users.list()
            return userlist.map(userToUserRef)
        }
    }
}

async function testSetup() {
    let config = new Config({configDir: "./config"})
    Config.setActiveConfig(config)
    await db.setup(config)
    await setup()

}

// 3
export async function setup() {
    const server = new ApolloServer({typeDefs, resolvers})
    server.listen({port: 4005})
        .then(({ url }) => 
            console.log(`Server is running on ${url}`)    
        )
}
