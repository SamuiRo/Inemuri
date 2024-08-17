const { CosmosClient } = require("@azure/cosmos");

const { ENDPOINT, KEY, COSMOS_DB_ID } = require("../../config/cosmos-db-config");

const endpoint = ENDPOINT;
const key = KEY;

const client = new CosmosClient({ endpoint, key });
const databaseId = COSMOS_DB_ID;
//STEAM QUE
async function upsert_single_steammarket_item(item) {
    try {
        const container = client.database(databaseId).container('Steam_Items');

        // Перевірка наявності запису за market_hash_name
        const querySpec = {
            query: 'SELECT * FROM c WHERE c.market_hash_name = @marketHashName',
            parameters: [
                {
                    name: '@marketHashName',
                    value: item.market_hash_name,
                },
            ],
        };
        const { resources: existingItems } = await container.items.query(querySpec).fetchAll();

        if (existingItems.length > 0) {
            // Якщо запис існує, виконайте оновлення
            const existingItem = existingItems[0];
            Object.assign(existingItem, item);
            await container.item(existingItem.id).replace(existingItem);
        } else {
            // Якщо запис відсутній, виконайте вставку
            await container.items.create(item);
        }
        return item.market_hash_name
    } catch (error) {
        console.log(error)
        return "ERROR"
    }
}

async function get_all_steam_stems() {
    const container = client.database(databaseId).container('Steam_Items');

    const { resources: items } = await container.items.readAll().fetchAll();
    return items;
}

module.exports = {
    upsert_single_steammarket_item,
}