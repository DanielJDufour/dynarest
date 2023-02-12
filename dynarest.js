const AWS = require("aws-sdk");
const Ajv = require("ajv");

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");

const { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, ScanCommand } = require("@aws-sdk/lib-dynamodb");

const AJV_TYPE_TO_KEY_TYPE = {
  string: "S",
  number: "N"
};

class Dynarest {
  ajv = null;
  client = null;
  schema = null;
  table = null;

  constructor({ accessKeyId, ajv, base_client, client, document_client, endpoint, key, region, schema, secretAccessKey, table }) {
    this.ajv = ajv;
    this.base_client = base_client;
    this.client = client;
    this.document_client = document_client;
    this.endpoint = endpoint;
    this.key = key;
    this.region = region;
    this.schema = schema;
    this.table = table;
  }

  static async init({ accessKeyId, debug, endpoint, key, region, secretAccessKey, schema, table, translateConfig }) {
    if (debug) console.log("[dynarest] initializing");

    if (!table) throw Error("[dynarest] table missing");

    const base_client = new AWS.DynamoDB({
      accessKeyId,
      endpoint,
      region,
      secretAccessKey
    });

    const client = new DynamoDBClient({
      endpoint,
      region
    });

    const document_client = DynamoDBDocumentClient.from(client, translateConfig);

    // get attribute definitions from schema
    const attribute_definitions = Object.entries(schema.properties)
      .sort()
      .map(([name, { type }]) => ({
        AttributeName: name,
        AttributeType: AJV_TYPE_TO_KEY_TYPE[type] || "S"
      }));

    const tables = await new Promise((resolve, reject) => {
      base_client.listTables({}, (err, data) => (err ? reject(err) : resolve(data.TableNames)));
    });

    if (!tables.includes(table)) {
      await new Promise((resolve, reject) => {
        base_client.createTable(
          {
            AttributeDefinitions: [
              {
                AttributeName: key,
                AttributeType: AJV_TYPE_TO_KEY_TYPE[schema.properties[key].type]
              }
            ],
            KeySchema: [{ AttributeName: key, KeyType: "HASH" }],
            ProvisionedThroughput: {
              ReadCapacityUnits: 5,
              WriteCapacityUnits: 5
            },
            TableName: table
          },
          (err, data) => (err ? reject(err) : resolve(data))
        );
      });
    }

    return new Dynarest({
      ajv: new Ajv(),
      attribute_definitions,
      base_client,
      client,
      document_client,
      key,
      schema,
      table
    });
  }

  async check(obj) {
    const [valid, errors] = this.validate(obj);
    if (!valid) throw Error("[dynarest] invalid object", { cause: errors });
  }

  async delete(hash) {
    if (hash) {
      await this.document_client.send(
        new DeleteCommand({
          TableName: this.table,
          Key: {
            [this.key]: hash
          }
        })
      );
    } else {
      const items = await this.get();
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const value = item[this.key];
        await this.document_client.send(
          new DeleteCommand({
            TableName: this.table,
            Key: {
              [this.key]: value
            }
          })
        );
        if (this.debug) console.log("[dynarest] deleted " + value);
      }
    }
  }

  async get(value, {} = {}) {
    if (value) {
      const { Item: item } = await this.document_client.send(
        new GetCommand({
          TableName: this.table,
          Key: {
            [this.key]: value
          }
        })
      );
      return [item];
    } else {
      const { Items: items } = await this.document_client.send(
        new ScanCommand({
          TableName: this.table
        })
      );
      if (this.debug) console.log(`[dynarest] retrieved ${items.length} total items`);

      const cleaned = [];
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const [valid, errors] = this.validate(item);
        if (valid) {
          cleaned.push(item);
        } else {
          console.error("[dynarest] invalid item:", item);
          console.error("[dynarest] ajv.errors:", errors);
        }
      }

      return cleaned;
    }
  }

  async put(obj) {
    this.check(obj);
    await this.document_client.send(
      new PutCommand({
        TableName: this.table,
        Item: obj
      })
    );
  }

  validate(obj) {
    return [this.ajv.validate(this.schema, obj), this.ajv.errors];
  }
}

module.exports = { Dynarest };
