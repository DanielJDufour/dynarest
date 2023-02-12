const crypto = require("node:crypto");
const fs = require("fs");
const test = require("flug");
const { Dynarest } = require("./dynarest.js");

const ENDPOINT = "http://localhost:9000";
const TABLE_NAME = "TABLE_NAME";

const schema = JSON.parse(fs.readFileSync("./test-data/schema.json", "utf-8"));

test("Dynarest", async ({ eq }) => {
  const dyna = await Dynarest.init({
    debug: true,
    endpoint: ENDPOINT,
    key: "uuid",
    region: "us-east-1",
    schema,
    table: TABLE_NAME
  });

  // clear out any previous additions
  await dyna.delete();

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
