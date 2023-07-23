const axios = require("axios")

async function check_starknet_address(addresses) {
    try {
        let options = {
            content: "Address is empty",
            ephemeral: true,
        }

        if (!addresses) return options

        const data = JSON.stringify({
            "data": addresses
        });

        const config = {
            method: 'post',
            maxBodyLength: Infinity,
            url: 'https://starkstats.xyz/api/batchcheck',
            headers: {
                'authority': 'starkstats.xyz',
                'accept': '*/*',
                'accept-language': 'en-US,en;q=0.9',
                'content-type': 'application/json',
                'origin': 'https://starkstats.xyz',
                'referer': 'https://starkstats.xyz/batchcheck',
                'sec-ch-ua': '"Not.A/Brand";v="8", "Chromium";v="114", "Microsoft Edge";v="114"',
                'sec-ch-ua-mobile': '?0',
                'sec-ch-ua-platform': '"Windows"',
                'sec-fetch-dest': 'empty',
                'sec-fetch-mode': 'cors',
                'sec-fetch-site': 'same-origin',
                'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36 Edg/114.0.1823.82'
            },
            data: data
        };

        const response = await axios.request(config)

        options.content = ""
        response.data.data.forEach(element => {
            message = message +
                "〓━━━━━━━━━━━━━━━" + "\n" +
                "Address: " + element.contract + "\n" +
                "txCount: " + element.nonce + "\n" +
                "Balance: " + element.balance + "\n" +
                "Active days/weeks/month: " + element.txTimestamps + "\n"
        });

        return options
    } catch (error) {
        console.log(error)
    }
}

async function check_layerzero_address(address) {
    try {
        let options = {
            content: "Address is empty",
            ephemeral: true,
        }

        if (!address) return options

        let data = JSON.stringify({
            address
        });

        let config = {
            method: 'post',
            maxBodyLength: Infinity,
            url: 'https://api.nftcopilot.com/layer-zero-rank/check',
            headers: {
                'authority': 'api.nftcopilot.com',
                'accept': 'application/json',
                'accept-language': 'en-US,en;q=0.9',
                'content-type': 'application/json',
                'cookie': '_ga=GA1.1.762960082.1690037138; _gcl_au=1.1.930620833.1690037138; _ga_R15ECYX6FF=GS1.1.1690043308.2.0.1690043308.0.0.0',
                'origin': 'https://nftcopilot.com',
                'referer': 'https://nftcopilot.com/',
                'sec-ch-ua': '"Not.A/Brand";v="8", "Chromium";v="114", "Microsoft Edge";v="114"',
                'sec-ch-ua-mobile': '?0',
                'sec-ch-ua-platform': '"Windows"',
                'sec-fetch-dest': 'empty',
                'sec-fetch-mode': 'cors',
                'sec-fetch-site': 'same-site',
                'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36 Edg/114.0.1823.82'
            },
            data: data
        };

        const response = await axios.request(config)

        options.content = "〓━━━ Rank [ " + response.data.rank + " ] \n" +
            "| TxCount:      " + response.data.txsCount + " [Top " + response.data.topInTxs + "%]\n" +
            "| Volume:       " + response.data.volume + " [Top " + response.data.topInVolume + "%]\n" +
            "| Months:       " + response.data.distinctMonths + " [Top " + response.data.topInUsageByMonth + "%]\n" +
            "| Networks:    " + response.data.networks + " [Top " + response.data.topInUsageByNetwork + "%]\n" +
            "| Final Score: " + "Top " + response.data.topFinal + "%\n" +
            "| Total Users: " + response.data.totalUsers

        return options
    } catch (error) {
        console.log(error)
    }
}

module.exports = {
    check_starknet_address,
    check_layerzero_address
}