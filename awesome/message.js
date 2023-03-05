const chalk = require("chalk")

const FORMATTED_LOGO =
  "" + "\n" +
  "" + "\n" +
  "  _____        _____        _____" + "\n" +
  " /     \\      /     \\      /     \\" + "\n" +
  "<       >----<       >----<       >     _______ _______ _______ _     _ _____  ______  _____ " + "\n" +
  " \\_____/      \\_____/      \\_____/      |______ |_____| |  |  | |     |   |   |_____/ |     |" + "\n" +
  " /     \\      /     \\      /     \\      ______| |     | |  |  | |_____| __|__ |    \\_ |_____|" + "\n" +
  "<       >----<       >----<       >----." + "\n" +
  " \\_____/      \\_____/      \\_____/      \\       寒い露" + "\n" +
  "       \\      /     \\      /     \\      /" + "\n" +
  "        >----<       >----<       >----<" + "\n" +
  "       /      \\_____/      \\_____/      \\_____            " + "\n" +
  "       \\      /     \\      /     \\      /     \\         " + "\n" +
  "        \`----<       >----<       >----<       >        " + "\n" +
  "              \\_____/      \\_____/      \\_____/       " + "\n" +
  "                           /     \\      /" + "\n" +
  "                          <       >----'" + "\n" +
  "                           \\_____/" + "\n" +
  "" + "\n" +
  "" + "\n"


function intro() {
  console.log(chalk.red(FORMATTED_LOGO))
}

module.exports = {
  intro
}