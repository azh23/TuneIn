import { Photon } from "@photon-ai/api";

const { PHOTON_API_KEY, PHOTON_PROJECT_ID, PHOTON_VOICE_PROFILE_ID } = process.env;
if (!PHOTON_API_KEY || !PHOTON_PROJECT_ID || !PHOTON_VOICE_PROFILE_ID) {
  throw new Error("Set PHOTON_API_KEY, PHOTON_PROJECT_ID, and PHOTON_VOICE_PROFILE_ID");
}

const photon = new Photon({
  headers: { Authorization: `Bearer ${PHOTON_API_KEY}` },
});

try {
  const profile = await photon.projects.platforms.getVoiceProfile({
    path: { id: PHOTON_PROJECT_ID, profileId: PHOTON_VOICE_PROFILE_ID },
  });
  console.log(JSON.stringify(profile, null, 2));
} catch {
  console.error("Could not read the Voice profile");
  process.exitCode = 1;
}

