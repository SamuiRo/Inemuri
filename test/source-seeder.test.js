import test from "node:test";
import assert from "node:assert/strict";

import SourceSeeder from "../src/module/seeders/Sourceseeder.js";

const seeder = new SourceSeeder();
const discord = (channel_id) => ({ platform: "discord", channel_id, channel_name: "Server · #news" });

test("discord source: channel_id must be a channel snowflake", () => {
  assert.equal(seeder.validateSource(discord("123456789012345678")), true);
  assert.equal(seeder.validateSource(discord(12345678901234567890n.toString())), true);
  for (const bad of ["123", "https://discord.com/channels/1/2", "#news", "1234567890123456789012"]) {
    assert.throws(() => seeder.validateSource(discord(bad)), /channel_id must be the channel id/, bad);
  }
});
