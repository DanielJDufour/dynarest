const crypto = require("node:crypto");
const fs = require("node:fs");

const fetch = require("cross-fetch");
const express = require("express");
const test = require("flug");

const { Dynarest, register } = require("./dynarest.js");

const ENDPOINT = "http://localhost:9000";
const TABLE_NAME = "TABLE_NAME";
const EXPRESS_PORT = 9001;
const EXPRESS_URL = `http://localhost:${EXPRESS_PORT}`;

const schema = JSON.parse(fs.readFileSync("./test-data/schema.json", "utf-8"));

const a = {
  uuid: crypto.randomUUID(),
  time: "08:10",
  title: "test title",
  year: 1900
};

const b = {
  uuid: crypto.randomUUID(),
  time: "08:10",
  title: "test different title",
  year: 2000
};

test("class", async ({ eq }) => {
  const dyna = await Dynarest.init({
    debug: false,
    endpoint: ENDPOINT,
    key: "uuid",
    region: "us-east-1",
    schema,
    table: TABLE_NAME
  });

  // clear out any previous additions
  await dyna.delete();

  await dyna.put(a);
  await dyna.put(b);

  eq((await dyna.get()).map(({ uuid }) => uuid).sort(), [a.uuid, b.uuid].sort());
  eq(await dyna.get(a.uuid), [a]);

  eq(await dyna.delete(a.uuid), undefined);
  eq(await dyna.get(), [b]);
  eq(await dyna.get(b.uuid), [b]);

  await dyna.delete();
  eq(await dyna.get(), []);
});

test("express", async ({ eq }) => {
  const app = express();

  app.use(express.json());

  await register(app, {
    debug: false,
    endpoint: ENDPOINT,
    key: "uuid",
    local: false,
    region: "us-east-1",
    schema,
    table: TABLE_NAME,
    timestamp: true,
    uuid: true
  });

  return new Promise((resolve, reject) => {
    const server = app.listen(EXPRESS_PORT, async () => {
      const http = {
        delete: url => fetch(url, { method: "DELETE" }).then(r => r.text()),
        get: url => fetch(url).then(r => r.json()),
        put: (url, params = {}) =>
          fetch(url, { body: JSON.stringify(params), headers: { "Content-Type": "application/json" }, method: "PUT" }).then(r => r.json())
      };

      const table_url = `${EXPRESS_URL}/api/${TABLE_NAME}`;

      eq(await http.delete(table_url), "");
      eq(await http.get(table_url), []);

      const aput = await http.put(table_url, a);
      eq(aput.title, a.title);

      const bput = await http.put(table_url, b);
      eq(bput.title, b.title);

      const rows = await http.get(table_url + "?sort=timestamp");
      eq(rows.length, 2);
      eq(rows[0].timestamp < rows[1].timestamp, true);

      const rows_reversed = await http.get(table_url + "?sort=-timestamp");
      eq(rows_reversed.length, 2);
      eq(rows_reversed[0].timestamp > rows_reversed[1].timestamp, true);

      eq(await http.get(table_url + "/" + aput.uuid), aput);

      eq(await http.delete(table_url + "/" + aput.uuid), "");

      eq(await http.get(table_url), [bput]);
      eq(await http.get(table_url + "/" + bput.uuid), bput);

      eq(await http.delete(table_url), "");
      eq(await http.get(table_url), []);

      server.close();
      resolve();
    });
  });
});
