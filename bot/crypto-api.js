const axios = require("axios")


fetch("https://starkstats.xyz/api/batchcheck", {
    "headers": {
        "accept": "*/*",
        "accept-language": "en-US,en;q=0.9",
        "content-type": "application/json",
        "sec-ch-ua": "\"Not.A/Brand\";v=\"8\", \"Chromium\";v=\"114\", \"Microsoft Edge\";v=\"114\"",
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": "\"Windows\"",
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin",
        "Referer": "https://starkstats.xyz/batchcheck",
        "Referrer-Policy": "strict-origin-when-cross-origin"
    },
    "body": "{\"data\":[\"0x076b99980250d844b1242145d7fe8c4d646d43857454d9134aaf4acefa81dca8\"]}",
    "method": "POST"
});

async function check_starknet_address(addresses) {
    try {
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

        let message = ""
        response.data.data.forEach(element => {
            message = message +
                "〓━━━━━━━━━━━━━━━" + "\n" +
                "Address: " + element.contract + "\n" +
                "txCount: " + element.nonce + "\n" +
                "Balance: " + element.balance + "\n" +
                "Active days/weeks/month: " + element.txTimestamps + "\n"
        });


        return message
    } catch (error) {
        console.log(error)
    }
}

module.exports = {
    check_starknet_address
}