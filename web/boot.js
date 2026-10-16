
import { GlonMachine } from "./glon-machine.js";
import { makeProjection } from "./geo.js";
import { profileSource } from "./glon-data.js";

export const LIBRARIES = [
  "vendor/glon/prelude.glon",
  "vendor/glon/strings.glon",
  "vendor/glon/kaka-lib-subset.glon",
  "glon/dd-support.glon",
];
export const ENGINE = [
  "glon/route-match.glon",
  "glon/fare.glon",
  "glon/journey.glon",
  "glon/candidates.glon",
  "glon/view.glon",
  "glon/app.glon",
];

export async function bootJourneyApp({ readText, readBytes, profile, region,
                                        farePolicy = "config/fare-policy.glon",
                                        journeyConfig = "config/journey-config.glon", log } = {}) {
  const machine = await GlonMachine.create(await readBytes("vendor/glon/glon-kaka.wasm"), { log });
  const proj = makeProjection(region.origin);
  for (const p of LIBRARIES) machine.load(await readText(p), p);
  machine.load(profileSource(profile, proj), "profile");
  machine.load(await readText(journeyConfig), journeyConfig);
  machine.load(await readText(farePolicy), farePolicy);
  for (const p of ENGINE) machine.load(await readText(p), p);
  machine.event("boot");
  return { machine, proj };
}
