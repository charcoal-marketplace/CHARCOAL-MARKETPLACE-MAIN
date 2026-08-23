const bcrypt = require("bcryptjs");

const password = process.argv[2] || "change-me";

bcrypt.hash(
  password,
  Number(process.env.BCRYPT_SALT_ROUNDS || 10),
  (err, hash) => {
    if (err) {
      console.error("Hash error:", err.message);
      process.exit(1);
    }

    console.log(hash);
  }
);
