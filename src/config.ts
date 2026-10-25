import "dotenv/config";

export const config = {
  port: Number(process.env.PORT ?? 3000),

  jwtSecret: process.env.JWT_SECRET,

  googleClientId: process.env.GOOGLE_CLIENT_ID,
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
  googleRedirectUri: process.env.GOOGLE_REDIRECT_URI,

  admobRewardedAdUnits: (process.env.ADMOB_REWARDED_AD_UNITS ?? "")
    .split(",").map(value => value.trim()).filter(Boolean),

  databaseUrl:
    process.env.DATABASE_URL ??
    "postgres://postgres:example@localhost:5432/tilegame"
};
