# dynarest
Lightweight Restful API for DynamoDB

## install
```bash
npm install -S dynarest
```

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