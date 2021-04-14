import { createValidator } from '../lib/schemas.js'

export const registerParam = createValidator({
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
