# dynarest
Lightweight Restful API for DynamoDB

## install
```bash
npm install -S dynarest
```

## Routes
The following routes are made available when calling `register`.  
See an example below.
| method | route | example | description |
| ------ | ----- | ---- | ----- |
| GET | /prefix/table | /api/cars | gets an array of all the rows |
| GET | /prefix/table/key | /api/cars/1234 | get a row by primary key |
| PUT | /prefix/table | /api/cars | add a row and return it |
| DELETE | /prefix/table | /api/cars | delete all rows |
| DELETE | /prefix/table/key | /api/cars/key | delete row by primary key |

## Routing
```js
const express = require("express");
const { register } = require("./dynarest.js");

const app = express();

// add json support to express app
app.use(express.json());

// register dynarest routes with the express app
await register(app, {
  autoCreate: false, // automatically create the table if it doesn't exist
  debug: false, // set to true for informational logging
  endpoint: 'http://localhost:9000', // useful if running DynamoDB locally
  key: "uuid", // Primary Hash Key for the DynamoDB Table
  local: false, // Optional, running DynamoDB locally
  prefix: 'api', // prefix to add before each route
  region: "us-east-1",
  schema, // Ajv Schema for items in DynamoDB table, see https://ajv.js.org/
  table: 'cars', // the name of the database table (will be created if missing)
  timestamp: true, // add a timestamp attribute to each item when created
  uuid: true // add a uuid attribute to each item when created
});
```


## Dynarest Client
```js
import { Dynarest } from "dynarest";

// automatically tries to create the table if it doesn't exist
const cars = await Dynarest.init({

  debug: true,

  endpoint: "http://localhost:9000", // optional

  // Primary Key
  key: 'uuid',

  region: 'us-east-1',

  // Ajv Schema, see https://ajv.js.org/
  schema: {
    type: "object",
    properties: {
      uuid: {
        type: "string",
        pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
      },
      make: { "type": "string" },
      model: { "type": "string" },
      year: { "type": "number" }
    },
    required: [
      "uuid",
      "make",
      "model"
    ]
  },

  // table name
  table: "cars"
});

// add item to table
cars.put({
  uuid: "9d22081f-47f2-433c-87af-2ebe936b4f87",
  make: "Nissan",
  model: "Versa",
  year: 2023
});

// get all items
cars.get();
[
  {
    uuid: "9d22081f-47f2-433c-87af-2ebe936b4f87",
    make: "Nissan",
    model: "Versa",
    year: 2023
  },
  {
    uuid: 'b0827664-128a-436a-b1b8-2722bcc444c5',
    make: "Tiguan",
    model: "Volkswagen",
    year: 2023
  },
  // ...
]

// get specific item by primary key
cars.get("9d22081f-47f2-433c-87af-2ebe936b4f87")
[
  {
    uuid: "9d22081f-47f2-433c-87af-2ebe936b4f87",
    make: "Nissan",
    model: "Versa",
    year: 2023
  }
]

// delete all the items from the table
cars.delete();

// delete item by primary key
cars.delete("9d22081f-47f2-433c-87af-2ebe936b4f87");
```