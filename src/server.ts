import { buildApp } from "./app.js";
import { config } from "./config.js";
import { tickTournaments } from "./services/tournament-bracket.js";

const app = buildApp();
let tournamentClock: NodeJS.Timeout | null = null;
app.addHook("onClose", async () => {
  if (tournamentClock) clearInterval(tournamentClock);
});

try {
  await app.listen({
    port: config.port,
    host: config.host
  });

  // Database time drives registration close, no-show and turn expiry even if
  // every client and admin browser is disconnected.
  let tournamentClockRunning = false;
  const runTournamentClock = async () => {
    if (tournamentClockRunning) return;
    tournamentClockRunning = true;
    try { await tickTournaments(); }
    catch (error) { app.log.error(error); }
    finally { tournamentClockRunning = false; }
  };
  await runTournamentClock();
  tournamentClock = setInterval(runTournamentClock, 5000);
  tournamentClock.unref();

  console.log(
    `Game API listening on port ${config.port}`
  );

} catch (error) {
  app.log.error(error);
  process.exit(1);
}
