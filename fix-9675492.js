// One-shot: clean evap-cooler leftovers off presence node 9675492 (keep name).
// Run only while homehub-server is STOPPED, else the live node re-persists stale data.
const Database = require("better-sqlite3");
const db = new Database("db/home-hub.db");
const id = "9675492";

const row = db.prepare("SELECT data FROM nodes WHERE id=?").get(id);
if (!row) { console.error("node not found"); process.exit(1); }

const data = JSON.parse(row.data);
console.log("BEFORE:", JSON.stringify({ name: data.name, type: data.type, value: data.value, channels: data.channels?.length }, null, 2));

data.type = "boolean";
data.value = false;
data.channels = [];
data.channelAware = false;
// name + deviceCategory ("presence") left intact

db.prepare("UPDATE nodes SET data=? WHERE id=?").run(JSON.stringify(data), id);
const after = JSON.parse(db.prepare("SELECT data FROM nodes WHERE id=?").get(id).data);
console.log("AFTER:", JSON.stringify({ name: after.name, deviceCategory: after.deviceCategory, type: after.type, value: after.value, channels: after.channels }, null, 2));
db.close();
console.log("done");
