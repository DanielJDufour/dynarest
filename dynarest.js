const crypto = require("node:crypto");

const AWS = require("aws-sdk");
const Ajv = require("ajv");

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");

const { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, ScanCommand } = require("@aws-sdk/lib-dynamodb");

const AJV_TYPE_TO_KEY_TYPE = {
  string: "S",
  number: "N"
};

const uniq = arr => Array.from(new Set(arr)).sort();

class Dynarest {
  ajv = null;
  client = null;
  ignoreProps = [];
  schema = null;
  table = null;

  constructor({ accessKeyId, ajv, base_client, client, debug, document_client, endpoint, ignoreProps, key, region, schema, secretAccessKey, table }) {
    this.ajv = ajv;
    this.base_client = base_client;
    this.client = client;
    this.debug = debug;
    this.document_client = document_client;
    this.endpoint = endpoint;
    this.key = key;
    this.region = region;
    this.schema = schema;
    this.ignoreProps = ignoreProps || [];
    this.table = table;
    if (debug) console.log("[dynarest] finished constructor");
  }

  static async init({
    accessKeyId,
    autoCreate = false,
    debug,
    endpoint,
    ignoreProps,
    key,
    region,
    secretAccessKey,
    sessionToken,
    schema,
    table,
    translateConfig
  }) {
    if (debug) {
      console.log("[dynarest] initializing with:");
      console.dir(arguments[0], { depth: 10 });
    }

    if (!table) throw Error("[dynarest] table missing");

    const base_client = new AWS.DynamoDB({
      accessKeyId,
      endpoint,
      region,
      secretAccessKey,
      sessionToken
    });
    if (debug) console.log("[dynarest] base_client:", typeof base_client);

    const client = new DynamoDBClient({
      endpoint,
      region
    });
    if (debug) console.log("[dynarest] client:", typeof client);

    const document_client = DynamoDBDocumentClient.from(client, translateConfig);
    if (debug) console.log("[dynarest] document_client:", typeof document_client);

    // get attribute definitions from schema
    const attribute_definitions = Object.entries(schema.properties)
      .sort()
      .map(([name, { type }]) => ({
        AttributeName: name,
        AttributeType: AJV_TYPE_TO_KEY_TYPE[type] || "S"
      }));
    if (debug) console.log("[dynarest] attribute_definitions:", attribute_definitions);

    if (autoCreate) {
      const tables = await new Promise((resolve, reject) => {
        base_client.listTables({}, (err, data) => {
          if (debug) console.log("[dynarest] listTables:", { err, data });
          if (err) {
            console.error("failed to list tables");
            reject(err);
          } else {
            resolve(data.TableNames);
          }
        });
      });
      if (debug) console.log("[dynarest] tables:", tables);

      if (!tables.includes(table)) {
        if (debug) console.log("[dynarest] creating table");
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
    }

    return new Dynarest({
      ajv: new Ajv(),
      attribute_definitions,
      base_client,
      client,
      debug,
      document_client,
      ignoreProps,
      key,
      schema,
      table
    });
  }

  check(obj) {
    const [valid, errors] = this.validate(obj);
    if (this.debug) console.error(errors);
    if (!valid) throw Error("[dynarest] invalid object", { cause: errors });
  }

  clean(obj) {
    const result = {};
    for (const key in obj) {
      if (this.ignoreProps.includes(key) === false) {
        result[key] = obj[key];
      }
    }
    return result;
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
      if (this.debug) console.log("[dynarest] deleteing all items from table one-by-one");
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
      if (this.debug) console.log("sending scan command");
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
    if (Array.isArray(obj)) {
      for (let i = 0; i < obj.length; i++) {
        const item = obj[i];
        const cleaned_item = this.clean(item);
        this.check(cleaned_item);
        await this.document_client.send(
          new PutCommand({
            TableName: this.table,
            Item: cleaned_item
          })
        );
      }
    } else {
      const cleaned_obj = this.clean(obj);
      this.check(cleaned_obj);
      await this.document_client.send(
        new PutCommand({
          TableName: this.table,
          Item: cleaned_obj
        })
      );
    }
  }

  validate(obj) {
    return [this.ajv.validate(this.schema, obj), this.ajv.errors];
  }
}

function register(
  app,
  {
    accessKeyId = process.env.AWS_ACCESS_KEY_ID,
    autoCreate = false,
    debug = false,
    endpoint = process.env.DYNAREST_ENDPOINT,
    local = false,
    key,
    prefix = `/api`,
    region = process.env.AWS_REGION,
    secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY,
    sessionToken = process.env.AWS_SESSION_TOKEN,
    schema,
    ignoreProps,
    table = process.env.DYNAREST_TABLE_NAME,
    timestamp = false,
    uuid = false
  }
) {
  if (debug) {
    console.log("[dynarest] starting register with options:");
    console.dir(arguments[1], { depth: 10 });
  }
  if (!key) throw new Error("[dynarest] missing key");
  if (!schema) throw new Error("[dynarest] missing schema");
  if (typeof prefix === "string" && prefix.length > 0 && !prefix.startsWith("/")) {
    prefix = "/" + prefix;
  }

  // if running locally,
  // these settings are ignored,
  // but still have to be provided
  if (local) {
    accessKeyId ??= "ACCESS_KEY_ID";
    region ??= "us-east-1";
    secretAccessKey ??= "SECRET_ACCESS_KE";
    table ??= "DYNAREST_TABLE";
  }

  // clone schema to preserve immutability
  schema = JSON.parse(JSON.stringify(schema));

  const dynarest = Dynarest.init({
    accessKeyId,
    autoCreate,
    debug,
    endpoint,
    ignoreProps,
    key,
    region,
    secretAccessKey,
    sessionToken,
    schema,
    table
  });

  const routes = [
    {
      method: "delete",
      path: [`${prefix}/${table}`, `${prefix}/${table}/`, `${prefix}/${table}/:key`],
      handler: async (req, res) => {
        try {
          const client = await dynarest;

          const { key } = req.params;

          await client.delete(key);

          return res.status(200).send();
        } catch (error) {
          console.error(error);
          return res.status(500).json(process.env.mode === "development" ? JSON.stringify({ msg: err.message }) : "error");
        }
      }
    },
    {
      method: "get",
      path: `${prefix}/${table}`,
      handler: async (req, res) => {
        try {
          if (debug) console.log("[dynarest] recv'd get request");

          const client = await dynarest;
          if (debug) console.log("client:", typeof client);

          const items = await client.get();
          if (debug) console.log("[dynarest] client.get() returned:", items);

          if (req.query.sort) {
            let { sort: sort_key } = req.query;
            if (debug) console.log("[dynarest] sort:", sort_key);
            if (sort_key.startsWith("-")) {
              sort_key = sort_key.substring(1); // remove -
              items.sort((a, b) => (Number(a[sort_key]) > Number(b[sort_key]) ? -1 : 1));
            } else {
              items.sort((a, b) => (Number(a[sort_key]) > Number(b[sort_key]) ? 1 : -1));
            }
          }

          return res.status(200).json(items);
        } catch (error) {
          console.log(error);
          return res.status(500).json({ error: "Could not retreive appointment check-ins" });
        }
      }
    },
    {
      method: "get",
      path: `${prefix}/${table}/:key`,
      handler: async (req, res) => {
        try {
          if (debug) console.log("[dynarest] recv'd get request");

          const client = await dynarest;
          if (debug) console.log("client:", client);

          const { key } = req.params;
          if (debug) console.log("key:", key);

          const [item] = await client.get(key);
          if (debug) console.log("[dynarest] item:", item);

          return res.status(200).json(item);
        } catch (error) {
          console.log(error);
          return res.status(500).json({ error: "Could not retreive appointment check-ins" });
        }
      }
    },
    {
      method: "put",
      path: `${prefix}/${table}`,
      handler: async function (req, res) {
        try {
          const client = await dynarest;

          const { body } = req;

          if (Array.isArray(body)) {
            const items = body;
            items.forEach(item => {
              if (uuid) item.uuid = crypto.randomUUID();
              if (timestamp) item.timestamp = new Date().getTime();
            });

            if (debug) console.log("[dynarest] putting items:", items);
            await client.put(items);

            return res.status(200).json(items);
          } else {
            const item = { ...body };
            if (uuid) item.uuid = crypto.randomUUID();
            if (timestamp) item.timestamp = new Date().getTime();

            if (debug) console.log("[dynarest] putting item:", item);
            await client.put(item);

            return res.status(200).json(item);
          }
        } catch (error) {
          console.log("[dynarest] error:", error);
          return res.status(500).json({ error: "put failed" });
        }
      }
    }
  ];

  // add options for each path
  routes.push({
    method: "options",
    path: uniq(routes.map(({ path }) => path).flat()),
    handler: async function (req, res) {
      res.header("Access-Control-Allow-Methods", "GET,PUT,POST,DELETE,OPTIONS");
      return res.status(200).send();
    }
  });

  routes.forEach(({ method, path, handler }) => {
    app[method](path, handler);
    console.log(`[dynarest] registered ${method.toUpperCase()} "${path}"`);
  });
}

module.exports = {
  Dynarest,
  register
};
