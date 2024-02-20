const axios = require("axios")
const cheerio = require("cheerio")

async function get_proxy_list() {
    const proxys = []

    try {
        let config = {
            method: "get",
            maxBodyLength: Infinity,
            url: "https://free-proxy-list.net/",
            headers: {}
        };

        const response = await axios.request(config)

        const $ = cheerio.load(response.data)

        const proxy_table = $("table.table.table-striped.table-bordered tr")

        proxy_table.each((index, element) => {
            const columns = $(element).find("td");

            if ($(columns[0]).text().trim() === "") return

            const rowData = {
                ipAddress: $(columns[0]).text(),
                port: $(columns[1]).text(),
                code: $(columns[2]).text(),
                country: $(columns[3]).text(),
                anonymity: $(columns[4]).text(),
                google: $(columns[5]).text(),
                https: $(columns[6]).text(),
                lastChecked: $(columns[7]).text()
            };

            proxys.push(rowData);
        });

        return proxys
    } catch (error) {
        console.log(error)
    }
}

async function get_single_proxy() {
    try {
        const response = await axios.get("http://pubproxy.com/api/proxy")

        return response.data.data[0]
    } catch (error) {
        console.log(error)
    }
}

module.exports = {
    get_proxy_list,
    get_single_proxy
}