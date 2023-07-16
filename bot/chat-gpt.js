const axios = require("axios")
const { Configuration, OpenAIApi } = require("openai")
const { OPENAI_TOKEN } = require("./../config/openai-config")

const configuration = new Configuration({
    apiKey: OPENAI_TOKEN,
})
const openai = new OpenAIApi(configuration)
// const response = await openai.listEngines()

async function runCompletion() {
    console.log(OPENAI_TOKEN)
    const completion = await openai.createCompletion({
        model: "text-davinci-003",
        prompt: "How are you today?",
    });
    console.log(completion.data.choices[0].text);
    return completion.data.choices[0].text
}

async function chatgpt_prompt() {

}

module.exports = {
    chatgpt_prompt,
    runCompletion
}