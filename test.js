const axios = require('axios');
const cheerio = require('cheerio');

const url = 'https://www.10kdrop.com/results?walletAddress=0x364aBC32aAdDee7E82416BB15d9d764AD373F17D&walletAddress2=0xb40f204B55Bbf35cd2c4c0D2144e480BC7874547&walletAddress3=&walletAddress4=&proCode=';

axios.get(url)
    .then((response) => {
        if (response.status === 200) {
            const html = response.data;
            const value = extractValueFromHtml(html);
            console.log('Extracted value:', value);
        } else {
            console.log('Failed to fetch the page.');
        }
    })
    .catch((error) => {
        console.log('Error occurred while fetching the page:', error.message);
    });

function extractValueFromHtml(html) {
    const $ = cheerio.load(html);
    // const scriptContents = $('td.walletText script').html();
    const scriptContents = $("body").html();

    // Отримаємо значення value1_gasfees змінної з JavaScript коду у скрипті
    // Отримаємо значення value1_gasfees змінної з JavaScript коду у скрипті
  const regexValue1 = /const value1_gasfees = ([\d.]+)/;
  const matchValue1 = scriptContents.match(regexValue1);

  // Отримаємо значення value1_2_gasfees змінної з JavaScript коду у скрипті
  const regexValue1_2 = /const value1_2_gasfees = ([\d.]+)/;
  const matchValue1_2 = scriptContents.match(regexValue1_2);

  const result = {};

  if (matchValue1 && matchValue1[1]) {
    result.value1_gasfees = parseFloat(matchValue1[1]);
  }

  if (matchValue1_2 && matchValue1_2[1]) {
    result.value1_2_gasfees = parseFloat(matchValue1_2[1]);
  }

  return result;
}