const axios = require("axios")
const cheerio = require('cheerio');

const { CMC_API_KEY } = require("../config/crypto-api-config")


async function check_starknet_address(addresses) {
    let options = {
        content: "Address is incorrect",
        ephemeral: true,
    }
    try {
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
    } catch (error) {
        console.log(error)
    } finally {
        return options
    }
}

async function check_layerzero_address(address) {
    let options = {
        content: "Address is incorrect",
        ephemeral: true,
    }
    try {
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

    } catch (error) {
        console.log(error)
    } finally {
        return options
    }
}

async function check_zksync_address(addresses) {
    let options = {
        content: "Address is incorrect",
        ephemeral: true,
    }
    try {
        if (!addresses) return options
        if (addresses.length > 4) {
            options.content = "Too many addresses at once [Max 4]"
            return options
        }

        // let url = `https://www.10kdrop.com/results?walletAddress=${}&walletAddress2=${}&walletAddress3=&walletAddress4=&proCode=`


        let url = "https://www.10kdrop.com/results?walletAddress=&walletAddress2=&walletAddress3=&walletAddress4=&proCode="

        const response = axios.get(url)



    } catch (error) {
        console.log(error)
    }
}

async function cmc_global_metrics() {
    try {
        const response = await axios.get('https://pro-api.coinmarketcap.com/v1/global-metrics/quotes/latest', {
            headers: {
                'X-CMC_PRO_API_KEY': CMC_API_KEY,
            },
        });

        return response.data.data
    } catch (error) {
        console.log(error)
    }
}

async function cmc_find_token(tiker) {
    try {
        const response = await axios.get('https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest', {
            headers: {
                'X-CMC_PRO_API_KEY': CMC_API_KEY,
            },
        });
        const token_stat = response.data.data.find(crypto => crypto.symbol == tiker)
        return token_stat
    } catch (error) {
        console.log(error)
    }
}

module.exports = {
    check_starknet_address,
    check_layerzero_address,
    cmc_global_metrics,
    cmc_find_token
}