const aws = require('aws-sdk')
const fs = require('fs')
const YAML = require('yaml').default

const secrets = YAML.parse(fs.readFileSync('.fly.secrets.yml', 'utf8'))

aws.config.update({
    accessKeyId: secrets.awsDbKeyId,
    secretAccessKey: secrets.awsDbSecretKey,
    region: 'us-east-1'
})

const db = new aws.DynamoDB()

const params = {
    TableName: 'flychat-messages',
    KeySchema: [
        { AttributeName: 'room', KeyType: 'HASH' }
    ],
    AttributeDefinitions: [
        { AttributeName: 'room', AttributeType: 'S' }
    ],
    ProvisionedThroughput: {
        ReadCapacityUnits: 5,
        WriteCapacityUnits: 5
    }
}

db.createTable(params, function (err, data) {
    if (err) {
        console.error('Unable to create table:', JSON.stringify(err, null, 2))
    } else {
        console.log('Created table:', JSON.stringify(data, null, 2))
    }
})
