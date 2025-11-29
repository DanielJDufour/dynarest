const crypto = require("node:crypto");

const Ajv = require("ajv");

const { DynamoDBClient, CreateTableCommand, UpdateTimeToLiveCommand, paginateListTables } = require("@aws-sdk/client-dynamodb");

const { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, ScanCommand } = require("@aws-sdk/lib-dynamodb");

const AJV_TYPE_TO_KEY_TYPE = {
  string: "S",
  number: "N"
};

const pick = (obj, keys) => Object.fromEntries(keys.map(key => [key, obj[key]]));

const uniq = arr => Array.from(new Set(arr)).sort();

const getAllTableNamesWithPaginator = async client => {
  let allTableNames = [];

  const paginator = paginateListTables({ client }, {});

  for await (const page of paginator) {
    if (page.TableNames) {
      allTableNames = allTableNames.concat(page.TableNames);
    }
  }

  return allTableNames;
};

class Dynarest {
  ajv = null;
  client = null;
  ignoreProps = [];
  schema = null;
  table = null;

  constructor({ accessKeyId, ajv, client, debug, document_client, endpoint, ignoreProps, key, region, schema, secretAccessKey, table }) {
    this.ajv = ajv;
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
    translateConfig,
    ttlAttribute = "expireAt"
  }) {
    if (debug) {
      console.log("[dynarest] initializing with:");
      console.dir(arguments[0], { depth: 10 });
    }

    if (!table) throw Error("[dynarest] table missing");

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
      const tables = await getAllTableNamesWithPaginator(client);
      if (debug) console.log("[dynarest] tables:", tables);

      if (!tables.includes(table)) {
        if (debug) console.log("[dynarest] creating table");
        const createTableOptions = {
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
        };
        if (debug) console.log("[dynarest] createTableOptions:", createTableOptions);
        const createTableCommand = new CreateTableCommand(createTableOptions);
        await client.send(createTableCommand);

        if (ttlAttribute) {
          const ttlOptions = {
            TableName: table,
            TimeToLiveSpecification: {
              Enabled: true,
              AttributeName: ttlAttribute
            }
          };
          const ttlCommand = new UpdateTimeToLiveCommand(ttlOptions);
          await client.send(ttlCommand);
        }
      }
    }

    return new Dynarest({
      ajv: new Ajv(),
      attribute_definitions,
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
    if (this.debug) console.error(JSON.stringify(errors));
    if (!valid) throw Error("[dynarest] invalid object", { cause: errors.length === 1 ? errors[0] : errors });
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
    addMethod = "PUT",
    alwaysOkay = false,
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
    ttl = Infinity, // how many seconds items should live for
    ttlAttribute = "expireAt",
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

  if (!["POST", "PUT", "post", "put", null, undefined].includes(addMethod)) {
    throw new Error(`[dynarest] invalid addMethod.  should be "POST" or "PUT"`);
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
    table,
    ttlAttribute: typeof ttl === "number" && ttl !== Infinity && ttl >= 1 && ttlAttribute
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
          return res.status(alwaysOkay ? 200 : 500).json(process.env.mode === "development" ? JSON.stringify({ msg: err.message }) : "error");
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

          let items = await client.get();
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

          if (req.query.limit) {
            const limit = Number(req.query.limit);
            if (limit === Number(limit) && limit !== Infinity && limit !== -Infinity) {
              items = items.slice(0, limit);
            }
          }

          const filters = Object.entries(req.query).filter(([key, value]) => key !== "sort" && key !== "limit" && key !== "fields");

          filters.forEach(([key, value]) => {
            if (typeof value === "object" && value !== null) {
              throw new Error("[dynarest] invalid filter value");
            }
          });

          if (filters.length >= 1) {
            // check if other params are valid keys
            items = items.filter(item => filters.every(([key, value]) => "" + item[key] === value));
          }

          if (req.query.fields) {
            const fields = req.query.fields.split(",");
            items = items.map(it => pick(it, fields));
          }

          return res.status(200).json(items);
        } catch (error) {
          console.log(error);
          return res.status(alwaysOkay ? 200 : 500).json({ error: "Could not retreive from table " + table });
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
          return res.status(alwaysOkay ? 200 : 500).json({ error: "Could not retreive from table " + table });
        }
      }
    },
    {
      method: ["POST", "post"].includes(addMethod) ? "post" : "put",
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
              if (typeof ttl === "number" && ttl !== Infinity && ttl >= 1) item[ttlAttribute] = Math.ceil((new Date().getTime() + ttl * 1000) / 1000);
            });

            if (debug) console.log("[dynarest] putting items:", items);
            await client.put(items);

            return res.status(200).json(items);
          } else {
            const item = { ...body };
            if (uuid) item.uuid = crypto.randomUUID();
            if (timestamp) item.timestamp = new Date().getTime();
            if (typeof ttl === "number" && ttl !== Infinity && ttl >= 1) item[ttlAttribute] = Math.ceil((new Date().getTime() + ttl * 1000) / 1000);

            if (debug) console.log("[dynarest] putting item:", item);
            await client.put(item);
            if (debug) console.log("[dynarest] finishing putting item");

            return res.status(200).json(item);
          }
        } catch (error) {
          console.log("[dynarest] error:", error);
          return res.status(alwaysOkay ? 200 : 500).json({ error: "put failed" });
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
