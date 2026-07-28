'use strict';

/**
 * Country calling-code -> currency lookup table.
 *
 * WHY THIS EXISTS: Kika started as a Nigeria-only product, but a
 * merchant's currency should never be a hardcoded assumption -- a
 * merchant messaging from a +233 (Ghana) number almost certainly runs
 * their business in Cedis, not Naira. Rather than call an external
 * exchange-rate API on every message (network latency, cost, and a
 * dependency that can go down), this is a static, offline lookup: the
 * merchant's WhatsApp number's country calling code deterministically
 * picks their default currency ONCE at signup (see
 * queries.findOrCreateMerchantByWhatsappNumber), and every receipt,
 * invoice, report, and reply after that just formats amounts in that
 * currency -- no per-message lookups, no API calls, no token cost.
 *
 * PROVENANCE: generated offline from the world-countries npm package's
 * idd.root/idd.suffixes + currencies fields (itself sourced from
 * restcountries.com / Wikipedia's country data), not maintained by
 * hand -- see scripts/generate-country-currency-table.js if this ever
 * needs regenerating (e.g. a currency redenomination). Run with:
 * npm run generate:country-currency
 *
 * KEYS are calling codes with the leading "+" stripped -- e.g. "234"
 * for Nigeria, "1201" for a US New Jersey number (the North American
 * Numbering Plan shares the bare "+1" root across ~25
 * countries/territories, disambiguated only by the area code that
 * follows -- so NANP entries are keyed by the FULL root+area-code
 * string, not just "1"). Keys are looked up longest-prefix-first -- see
 * resolveByPhoneNumber below -- so this disambiguation, and a handful of
 * similar cases (Russia/Kazakhstan under +7, Western Sahara inside
 * Morocco's +212 range, Vatican City inside Italy's +39 range), resolve
 * correctly without any special-casing in the lookup itself.
 *
 * A few calling codes are shared by a populous nation and a much
 * smaller dependency using the SAME currency (e.g. +44 covers the UK as
 * well as Jersey/Guernsey/Isle of Man, all GBP) -- the entry below
 * favors the larger nation's name for display purposes; the currency is
 * identical either way, so this never affects any actual money math.
 */

const COUNTRY_CURRENCY_BY_CALLING_CODE = {
  20: {
    country: "Egypt",
    currencyCode: "EGP",
    currencySymbol: "£",
    currencyName: "Egyptian pound"
  },
  27: {
    country: "South Africa",
    currencyCode: "ZAR",
    currencySymbol: "R",
    currencyName: "South African rand"
  },
  30: {
    country: "Greece",
    currencyCode: "EUR",
    currencySymbol: "€",
    currencyName: "Euro"
  },
  31: {
    country: "Netherlands",
    currencyCode: "EUR",
    currencySymbol: "€",
    currencyName: "Euro"
  },
  32: {
    country: "Belgium",
    currencyCode: "EUR",
    currencySymbol: "€",
    currencyName: "Euro"
  },
  33: {
    country: "France",
    currencyCode: "EUR",
    currencySymbol: "€",
    currencyName: "Euro"
  },
  34: {
    country: "Spain",
    currencyCode: "EUR",
    currencySymbol: "€",
    currencyName: "Euro"
  },
  36: {
    country: "Hungary",
    currencyCode: "HUF",
    currencySymbol: "Ft",
    currencyName: "Hungarian forint"
  },
  39: {
    country: "Italy",
    currencyCode: "EUR",
    currencySymbol: "€",
    currencyName: "Euro"
  },
  40: {
    country: "Romania",
    currencyCode: "RON",
    currencySymbol: "lei",
    currencyName: "Romanian leu"
  },
  41: {
    country: "Switzerland",
    currencyCode: "CHF",
    currencySymbol: "Fr.",
    currencyName: "Swiss franc"
  },
  43: {
    country: "Austria",
    currencyCode: "EUR",
    currencySymbol: "€",
    currencyName: "Euro"
  },
  44: {
    country: "United Kingdom",
    currencyCode: "GBP",
    currencySymbol: "£",
    currencyName: "British pound"
  },
  45: {
    country: "Denmark",
    currencyCode: "DKK",
    currencySymbol: "kr",
    currencyName: "Danish krone"
  },
  46: {
    country: "Sweden",
    currencyCode: "SEK",
    currencySymbol: "kr",
    currencyName: "Swedish krona"
  },
  47: {
    country: "Norway",
    currencyCode: "NOK",
    currencySymbol: "kr",
    currencyName: "Norwegian krone"
  },
  48: {
    country: "Poland",
    currencyCode: "PLN",
    currencySymbol: "zł",
    currencyName: "Polish złoty"
  },
  49: {
    country: "Germany",
    currencyCode: "EUR",
    currencySymbol: "€",
    currencyName: "Euro"
  },
  51: {
    country: "Peru",
    currencyCode: "PEN",
    currencySymbol: "S/.",
    currencyName: "Peruvian sol"
  },
  52: {
    country: "Mexico",
    currencyCode: "MXN",
    currencySymbol: "$",
    currencyName: "Mexican peso"
  },
  53: {
    country: "Cuba",
    currencyCode: "CUC",
    currencySymbol: "$",
    currencyName: "Cuban convertible peso"
  },
  54: {
    country: "Argentina",
    currencyCode: "ARS",
    currencySymbol: "$",
    currencyName: "Argentine peso"
  },
  55: {
    country: "Brazil",
    currencyCode: "BRL",
    currencySymbol: "R$",
    currencyName: "Brazilian real"
  },
  56: {
    country: "Chile",
    currencyCode: "CLP",
    currencySymbol: "$",
    currencyName: "Chilean peso"
  },
  57: {
    country: "Colombia",
    currencyCode: "COP",
    currencySymbol: "$",
    currencyName: "Colombian peso"
  },
  58: {
    country: "Venezuela",
    currencyCode: "VES",
    currencySymbol: "Bs.S.",
    currencyName: "Venezuelan bolívar soberano"
  },
  60: {
    country: "Malaysia",
    currencyCode: "MYR",
    currencySymbol: "RM",
    currencyName: "Malaysian ringgit"
  },
  61: {
    country: "Australia",
    currencyCode: "AUD",
    currencySymbol: "$",
    currencyName: "Australian dollar"
  },
  62: {
    country: "Indonesia",
    currencyCode: "IDR",
    currencySymbol: "Rp",
    currencyName: "Indonesian rupiah"
  },
  63: {
    country: "Philippines",
    currencyCode: "PHP",
    currencySymbol: "₱",
    currencyName: "Philippine peso"
  },
  64: {
    country: "Pitcairn Islands",
    currencyCode: "NZD",
    currencySymbol: "$",
    currencyName: "New Zealand dollar"
  },
  65: {
    country: "Singapore",
    currencyCode: "SGD",
    currencySymbol: "$",
    currencyName: "Singapore dollar"
  },
  66: {
    country: "Thailand",
    currencyCode: "THB",
    currencySymbol: "฿",
    currencyName: "Thai baht"
  },
  73: {
    country: "Russia",
    currencyCode: "RUB",
    currencySymbol: "₽",
    currencyName: "Russian ruble"
  },
  74: {
    country: "Russia",
    currencyCode: "RUB",
    currencySymbol: "₽",
    currencyName: "Russian ruble"
  },
  75: {
    country: "Russia",
    currencyCode: "RUB",
    currencySymbol: "₽",
    currencyName: "Russian ruble"
  },
  76: {
    country: "Kazakhstan",
    currencyCode: "KZT",
    currencySymbol: "₸",
    currencyName: "Kazakhstani tenge"
  },
  77: {
    country: "Kazakhstan",
    currencyCode: "KZT",
    currencySymbol: "₸",
    currencyName: "Kazakhstani tenge"
  },
  78: {
    country: "Russia",
    currencyCode: "RUB",
    currencySymbol: "₽",
    currencyName: "Russian ruble"
  },
  79: {
    country: "Russia",
    currencyCode: "RUB",
    currencySymbol: "₽",
    currencyName: "Russian ruble"
  },
  81: {
    country: "Japan",
    currencyCode: "JPY",
    currencySymbol: "¥",
    currencyName: "Japanese yen"
  },
  82: {
    country: "South Korea",
    currencyCode: "KRW",
    currencySymbol: "₩",
    currencyName: "South Korean won"
  },
  84: {
    country: "Vietnam",
    currencyCode: "VND",
    currencySymbol: "₫",
    currencyName: "Vietnamese đồng"
  },
  86: {
    country: "China",
    currencyCode: "CNY",
    currencySymbol: "¥",
    currencyName: "Chinese yuan"
  },
  90: {
    country: "Türkiye",
    currencyCode: "TRY",
    currencySymbol: "₺",
    currencyName: "Turkish lira"
  },
  91: {
    country: "India",
    currencyCode: "INR",
    currencySymbol: "₹",
    currencyName: "Indian rupee"
  },
  92: {
    country: "Pakistan",
    currencyCode: "PKR",
    currencySymbol: "₨",
    currencyName: "Pakistani rupee"
  },
  93: {
    country: "Afghanistan",
    currencyCode: "AFN",
    currencySymbol: "؋",
    currencyName: "Afghan afghani"
  },
  94: {
    country: "Sri Lanka",
    currencyCode: "LKR",
    currencySymbol: "Rs  රු",
    currencyName: "Sri Lankan rupee"
  },
  95: {
    country: "Myanmar",
    currencyCode: "MMK",
    currencySymbol: "Ks",
    currencyName: "Burmese kyat"
  },
  98: {
    country: "Iran",
    currencyCode: "IRR",
    currencySymbol: "﷼",
    currencyName: "Iranian rial"
  },
  211: {
    country: "South Sudan",
    currencyCode: "SSP",
    currencySymbol: "£",
    currencyName: "South Sudanese pound"
  },
  212: {
    country: "Morocco",
    currencyCode: "MAD",
    currencySymbol: "د.م.",
    currencyName: "Moroccan dirham"
  },
  213: {
    country: "Algeria",
    currencyCode: "DZD",
    currencySymbol: "د.ج",
    currencyName: "Algerian dinar"
  },
  216: {
    country: "Tunisia",
    currencyCode: "TND",
    currencySymbol: "د.ت",
    currencyName: "Tunisian dinar"
  },
  218: {
    country: "Libya",
    currencyCode: "LYD",
    currencySymbol: "ل.د",
    currencyName: "Libyan dinar"
  },
  220: {
    country: "Gambia",
    currencyCode: "GMD",
    currencySymbol: "D",
    currencyName: "dalasi"
  },
  221: {
    country: "Senegal",
    currencyCode: "XOF",
    currencySymbol: "Fr",
    currencyName: "West African CFA franc"
  },
  222: {
    country: "Mauritania",
    currencyCode: "MRU",
    currencySymbol: "UM",
    currencyName: "Mauritanian ouguiya"
  },
  223: {
    country: "Mali",
    currencyCode: "XOF",
    currencySymbol: "Fr",
    currencyName: "West African CFA franc"
  },
  224: {
    country: "Guinea",
    currencyCode: "GNF",
    currencySymbol: "Fr",
    currencyName: "Guinean franc"
  },
  225: {
    country: "Ivory Coast",
    currencyCode: "XOF",
    currencySymbol: "Fr",
    currencyName: "West African CFA franc"
  },
  226: {
    country: "Burkina Faso",
    currencyCode: "XOF",
    currencySymbol: "Fr",
    currencyName: "West African CFA franc"
  },
  227: {
    country: "Niger",
    currencyCode: "XOF",
    currencySymbol: "Fr",
    currencyName: "West African CFA franc"
  },
  228: {
    country: "Togo",
    currencyCode: "XOF",
    currencySymbol: "Fr",
    currencyName: "West African CFA franc"
  },
  229: {
    country: "Benin",
    currencyCode: "XOF",
    currencySymbol: "Fr",
    currencyName: "West African CFA franc"
  },
  230: {
    country: "Mauritius",
    currencyCode: "MUR",
    currencySymbol: "₨",
    currencyName: "Mauritian rupee"
  },
  231: {
    country: "Liberia",
    currencyCode: "LRD",
    currencySymbol: "$",
    currencyName: "Liberian dollar"
  },
  232: {
    country: "Sierra Leone",
    currencyCode: "SLL",
    currencySymbol: "Le",
    currencyName: "Sierra Leonean leone"
  },
  233: {
    country: "Ghana",
    currencyCode: "GHS",
    currencySymbol: "₵",
    currencyName: "Ghanaian cedi"
  },
  234: {
    country: "Nigeria",
    currencyCode: "NGN",
    currencySymbol: "₦",
    currencyName: "Nigerian naira"
  },
  235: {
    country: "Chad",
    currencyCode: "XAF",
    currencySymbol: "Fr",
    currencyName: "Central African CFA franc"
  },
  236: {
    country: "Central African Republic",
    currencyCode: "XAF",
    currencySymbol: "Fr",
    currencyName: "Central African CFA franc"
  },
  237: {
    country: "Cameroon",
    currencyCode: "XAF",
    currencySymbol: "Fr",
    currencyName: "Central African CFA franc"
  },
  238: {
    country: "Cape Verde",
    currencyCode: "CVE",
    currencySymbol: "Esc",
    currencyName: "Cape Verdean escudo"
  },
  239: {
    country: "São Tomé and Príncipe",
    currencyCode: "STN",
    currencySymbol: "Db",
    currencyName: "São Tomé and Príncipe dobra"
  },
  240: {
    country: "Equatorial Guinea",
    currencyCode: "XAF",
    currencySymbol: "Fr",
    currencyName: "Central African CFA franc"
  },
  241: {
    country: "Gabon",
    currencyCode: "XAF",
    currencySymbol: "Fr",
    currencyName: "Central African CFA franc"
  },
  242: {
    country: "Republic of the Congo",
    currencyCode: "XAF",
    currencySymbol: "Fr",
    currencyName: "Central African CFA franc"
  },
  243: {
    country: "DR Congo",
    currencyCode: "CDF",
    currencySymbol: "FC",
    currencyName: "Congolese franc"
  },
  244: {
    country: "Angola",
    currencyCode: "AOA",
    currencySymbol: "Kz",
    currencyName: "Angolan kwanza"
  },
  245: {
    country: "Guinea-Bissau",
    currencyCode: "XOF",
    currencySymbol: "Fr",
    currencyName: "West African CFA franc"
  },
  246: {
    country: "British Indian Ocean Territory",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  247: {
    country: "Saint Helena, Ascension and Tristan da Cunha",
    currencyCode: "GBP",
    currencySymbol: "£",
    currencyName: "Pound sterling"
  },
  248: {
    country: "Seychelles",
    currencyCode: "SCR",
    currencySymbol: "₨",
    currencyName: "Seychellois rupee"
  },
  249: {
    country: "Sudan",
    currencyCode: "SDG",
    currencySymbol: "PT",
    currencyName: "Sudanese pound"
  },
  250: {
    country: "Rwanda",
    currencyCode: "RWF",
    currencySymbol: "Fr",
    currencyName: "Rwandan franc"
  },
  251: {
    country: "Ethiopia",
    currencyCode: "ETB",
    currencySymbol: "Br",
    currencyName: "Ethiopian birr"
  },
  252: {
    country: "Somalia",
    currencyCode: "SOS",
    currencySymbol: "Sh",
    currencyName: "Somali shilling"
  },
  253: {
    country: "Djibouti",
    currencyCode: "DJF",
    currencySymbol: "Fr",
    currencyName: "Djiboutian franc"
  },
  254: {
    country: "Kenya",
    currencyCode: "KES",
    currencySymbol: "Sh",
    currencyName: "Kenyan shilling"
  },
  255: {
    country: "Tanzania",
    currencyCode: "TZS",
    currencySymbol: "Sh",
    currencyName: "Tanzanian shilling"
  },
  256: {
    country: "Uganda",
    currencyCode: "UGX",
    currencySymbol: "Sh",
    currencyName: "Ugandan shilling"
  },
  257: {
    country: "Burundi",
    currencyCode: "BIF",
    currencySymbol: "Fr",
    currencyName: "Burundian franc"
  },
  258: {
    country: "Mozambique",
    currencyCode: "MZN",
    currencySymbol: "MT",
    currencyName: "Mozambican metical"
  },
  260: {
    country: "Zambia",
    currencyCode: "ZMW",
    currencySymbol: "ZK",
    currencyName: "Zambian kwacha"
  },
  261: {
    country: "Madagascar",
    currencyCode: "MGA",
    currencySymbol: "Ar",
    currencyName: "Malagasy ariary"
  },
  262: {
    country: "Réunion",
    currencyCode: "EUR",
    currencySymbol: "€",
    currencyName: "Euro"
  },
  263: {
    country: "Zimbabwe",
    currencyCode: "BWP",
    currencySymbol: "P",
    currencyName: "Botswana pula"
  },
  264: {
    country: "Namibia",
    currencyCode: "NAD",
    currencySymbol: "$",
    currencyName: "Namibian dollar"
  },
  265: {
    country: "Malawi",
    currencyCode: "MWK",
    currencySymbol: "MK",
    currencyName: "Malawian kwacha"
  },
  266: {
    country: "Lesotho",
    currencyCode: "LSL",
    currencySymbol: "L",
    currencyName: "Lesotho loti"
  },
  267: {
    country: "Botswana",
    currencyCode: "BWP",
    currencySymbol: "P",
    currencyName: "Botswana pula"
  },
  268: {
    country: "Eswatini",
    currencyCode: "SZL",
    currencySymbol: "L",
    currencyName: "Swazi lilangeni"
  },
  269: {
    country: "Comoros",
    currencyCode: "KMF",
    currencySymbol: "Fr",
    currencyName: "Comorian franc"
  },
  290: {
    country: "Saint Helena, Ascension and Tristan da Cunha",
    currencyCode: "GBP",
    currencySymbol: "£",
    currencyName: "Pound sterling"
  },
  291: {
    country: "Eritrea",
    currencyCode: "ERN",
    currencySymbol: "Nfk",
    currencyName: "Eritrean nakfa"
  },
  297: {
    country: "Aruba",
    currencyCode: "AWG",
    currencySymbol: "ƒ",
    currencyName: "Aruban florin"
  },
  298: {
    country: "Faroe Islands",
    currencyCode: "DKK",
    currencySymbol: "kr",
    currencyName: "Danish krone"
  },
  299: {
    country: "Greenland",
    currencyCode: "DKK",
    currencySymbol: "kr.",
    currencyName: "krone"
  },
  350: {
    country: "Gibraltar",
    currencyCode: "GIP",
    currencySymbol: "£",
    currencyName: "Gibraltar pound"
  },
  351: {
    country: "Portugal",
    currencyCode: "EUR",
    currencySymbol: "€",
    currencyName: "Euro"
  },
  352: {
    country: "Luxembourg",
    currencyCode: "EUR",
    currencySymbol: "€",
    currencyName: "Euro"
  },
  353: {
    country: "Ireland",
    currencyCode: "EUR",
    currencySymbol: "€",
    currencyName: "Euro"
  },
  354: {
    country: "Iceland",
    currencyCode: "ISK",
    currencySymbol: "kr",
    currencyName: "Icelandic króna"
  },
  355: {
    country: "Albania",
    currencyCode: "ALL",
    currencySymbol: "L",
    currencyName: "Albanian lek"
  },
  356: {
    country: "Malta",
    currencyCode: "EUR",
    currencySymbol: "€",
    currencyName: "Euro"
  },
  357: {
    country: "Cyprus",
    currencyCode: "EUR",
    currencySymbol: "€",
    currencyName: "Euro"
  },
  358: {
    country: "Finland",
    currencyCode: "EUR",
    currencySymbol: "€",
    currencyName: "Euro"
  },
  359: {
    country: "Bulgaria",
    currencyCode: "BGN",
    currencySymbol: "лв",
    currencyName: "Bulgarian lev"
  },
  370: {
    country: "Lithuania",
    currencyCode: "EUR",
    currencySymbol: "€",
    currencyName: "Euro"
  },
  371: {
    country: "Latvia",
    currencyCode: "EUR",
    currencySymbol: "€",
    currencyName: "Euro"
  },
  372: {
    country: "Estonia",
    currencyCode: "EUR",
    currencySymbol: "€",
    currencyName: "Euro"
  },
  373: {
    country: "Moldova",
    currencyCode: "MDL",
    currencySymbol: "L",
    currencyName: "Moldovan leu"
  },
  374: {
    country: "Armenia",
    currencyCode: "AMD",
    currencySymbol: "֏",
    currencyName: "Armenian dram"
  },
  375: {
    country: "Belarus",
    currencyCode: "BYN",
    currencySymbol: "Br",
    currencyName: "Belarusian ruble"
  },
  376: {
    country: "Andorra",
    currencyCode: "EUR",
    currencySymbol: "€",
    currencyName: "Euro"
  },
  377: {
    country: "Monaco",
    currencyCode: "EUR",
    currencySymbol: "€",
    currencyName: "Euro"
  },
  378: {
    country: "San Marino",
    currencyCode: "EUR",
    currencySymbol: "€",
    currencyName: "Euro"
  },
  379: {
    country: "Vatican City",
    currencyCode: "EUR",
    currencySymbol: "€",
    currencyName: "Euro"
  },
  380: {
    country: "Ukraine",
    currencyCode: "UAH",
    currencySymbol: "₴",
    currencyName: "Ukrainian hryvnia"
  },
  381: {
    country: "Serbia",
    currencyCode: "RSD",
    currencySymbol: "дин.",
    currencyName: "Serbian dinar"
  },
  382: {
    country: "Montenegro",
    currencyCode: "EUR",
    currencySymbol: "€",
    currencyName: "Euro"
  },
  383: {
    country: "Kosovo",
    currencyCode: "EUR",
    currencySymbol: "€",
    currencyName: "Euro"
  },
  385: {
    country: "Croatia",
    currencyCode: "EUR",
    currencySymbol: "€",
    currencyName: "Euro"
  },
  386: {
    country: "Slovenia",
    currencyCode: "EUR",
    currencySymbol: "€",
    currencyName: "Euro"
  },
  387: {
    country: "Bosnia and Herzegovina",
    currencyCode: "BAM",
    currencySymbol: "KM",
    currencyName: "Bosnia and Herzegovina convertible mark"
  },
  389: {
    country: "North Macedonia",
    currencyCode: "MKD",
    currencySymbol: "den",
    currencyName: "denar"
  },
  420: {
    country: "Czechia",
    currencyCode: "CZK",
    currencySymbol: "Kč",
    currencyName: "Czech koruna"
  },
  421: {
    country: "Slovakia",
    currencyCode: "EUR",
    currencySymbol: "€",
    currencyName: "Euro"
  },
  423: {
    country: "Liechtenstein",
    currencyCode: "CHF",
    currencySymbol: "Fr",
    currencyName: "Swiss franc"
  },
  500: {
    country: "Falkland Islands",
    currencyCode: "FKP",
    currencySymbol: "£",
    currencyName: "Falkland Islands pound"
  },
  501: {
    country: "Belize",
    currencyCode: "BZD",
    currencySymbol: "$",
    currencyName: "Belize dollar"
  },
  502: {
    country: "Guatemala",
    currencyCode: "GTQ",
    currencySymbol: "Q",
    currencyName: "Guatemalan quetzal"
  },
  503: {
    country: "El Salvador",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  504: {
    country: "Honduras",
    currencyCode: "HNL",
    currencySymbol: "L",
    currencyName: "Honduran lempira"
  },
  505: {
    country: "Nicaragua",
    currencyCode: "NIO",
    currencySymbol: "C$",
    currencyName: "Nicaraguan córdoba"
  },
  506: {
    country: "Costa Rica",
    currencyCode: "CRC",
    currencySymbol: "₡",
    currencyName: "Costa Rican colón"
  },
  507: {
    country: "Panama",
    currencyCode: "PAB",
    currencySymbol: "B/.",
    currencyName: "Panamanian balboa"
  },
  508: {
    country: "Saint Pierre and Miquelon",
    currencyCode: "EUR",
    currencySymbol: "€",
    currencyName: "Euro"
  },
  509: {
    country: "Haiti",
    currencyCode: "HTG",
    currencySymbol: "G",
    currencyName: "Haitian gourde"
  },
  590: {
    country: "Saint Martin",
    currencyCode: "EUR",
    currencySymbol: "€",
    currencyName: "Euro"
  },
  591: {
    country: "Bolivia",
    currencyCode: "BOB",
    currencySymbol: "Bs.",
    currencyName: "Bolivian boliviano"
  },
  592: {
    country: "Guyana",
    currencyCode: "GYD",
    currencySymbol: "$",
    currencyName: "Guyanese dollar"
  },
  593: {
    country: "Ecuador",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  594: {
    country: "French Guiana",
    currencyCode: "EUR",
    currencySymbol: "€",
    currencyName: "Euro"
  },
  595: {
    country: "Paraguay",
    currencyCode: "PYG",
    currencySymbol: "₲",
    currencyName: "Paraguayan guaraní"
  },
  596: {
    country: "Martinique",
    currencyCode: "EUR",
    currencySymbol: "€",
    currencyName: "Euro"
  },
  597: {
    country: "Suriname",
    currencyCode: "SRD",
    currencySymbol: "$",
    currencyName: "Surinamese dollar"
  },
  598: {
    country: "Uruguay",
    currencyCode: "UYU",
    currencySymbol: "$",
    currencyName: "Uruguayan peso"
  },
  599: {
    country: "Curaçao",
    currencyCode: "ANG",
    currencySymbol: "ƒ",
    currencyName: "Netherlands Antillean guilder"
  },
  670: {
    country: "Timor-Leste",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  672: {
    country: "Norfolk Island",
    currencyCode: "AUD",
    currencySymbol: "$",
    currencyName: "Australian dollar"
  },
  673: {
    country: "Brunei",
    currencyCode: "BND",
    currencySymbol: "$",
    currencyName: "Brunei dollar"
  },
  674: {
    country: "Nauru",
    currencyCode: "AUD",
    currencySymbol: "$",
    currencyName: "Australian dollar"
  },
  675: {
    country: "Papua New Guinea",
    currencyCode: "PGK",
    currencySymbol: "K",
    currencyName: "Papua New Guinean kina"
  },
  676: {
    country: "Tonga",
    currencyCode: "TOP",
    currencySymbol: "T$",
    currencyName: "Tongan paʻanga"
  },
  677: {
    country: "Solomon Islands",
    currencyCode: "SBD",
    currencySymbol: "$",
    currencyName: "Solomon Islands dollar"
  },
  678: {
    country: "Vanuatu",
    currencyCode: "VUV",
    currencySymbol: "Vt",
    currencyName: "Vanuatu vatu"
  },
  679: {
    country: "Fiji",
    currencyCode: "FJD",
    currencySymbol: "$",
    currencyName: "Fijian dollar"
  },
  680: {
    country: "Palau",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  681: {
    country: "Wallis and Futuna",
    currencyCode: "XPF",
    currencySymbol: "₣",
    currencyName: "CFP franc"
  },
  682: {
    country: "Cook Islands",
    currencyCode: "CKD",
    currencySymbol: "$",
    currencyName: "Cook Islands dollar"
  },
  683: {
    country: "Niue",
    currencyCode: "NZD",
    currencySymbol: "$",
    currencyName: "New Zealand dollar"
  },
  685: {
    country: "Samoa",
    currencyCode: "WST",
    currencySymbol: "T",
    currencyName: "Samoan tālā"
  },
  686: {
    country: "Kiribati",
    currencyCode: "AUD",
    currencySymbol: "$",
    currencyName: "Australian dollar"
  },
  687: {
    country: "New Caledonia",
    currencyCode: "XPF",
    currencySymbol: "₣",
    currencyName: "CFP franc"
  },
  688: {
    country: "Tuvalu",
    currencyCode: "AUD",
    currencySymbol: "$",
    currencyName: "Australian dollar"
  },
  689: {
    country: "French Polynesia",
    currencyCode: "XPF",
    currencySymbol: "₣",
    currencyName: "CFP franc"
  },
  690: {
    country: "Tokelau",
    currencyCode: "NZD",
    currencySymbol: "$",
    currencyName: "New Zealand dollar"
  },
  692: {
    country: "Marshall Islands",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  850: {
    country: "North Korea",
    currencyCode: "KPW",
    currencySymbol: "₩",
    currencyName: "North Korean won"
  },
  852: {
    country: "Hong Kong",
    currencyCode: "HKD",
    currencySymbol: "$",
    currencyName: "Hong Kong dollar"
  },
  853: {
    country: "Macau",
    currencyCode: "MOP",
    currencySymbol: "P",
    currencyName: "Macanese pataca"
  },
  855: {
    country: "Cambodia",
    currencyCode: "KHR",
    currencySymbol: "៛",
    currencyName: "Cambodian riel"
  },
  856: {
    country: "Laos",
    currencyCode: "LAK",
    currencySymbol: "₭",
    currencyName: "Lao kip"
  },
  880: {
    country: "Bangladesh",
    currencyCode: "BDT",
    currencySymbol: "৳",
    currencyName: "Bangladeshi taka"
  },
  886: {
    country: "Taiwan",
    currencyCode: "TWD",
    currencySymbol: "$",
    currencyName: "New Taiwan dollar"
  },
  960: {
    country: "Maldives",
    currencyCode: "MVR",
    currencySymbol: ".ރ",
    currencyName: "Maldivian rufiyaa"
  },
  961: {
    country: "Lebanon",
    currencyCode: "LBP",
    currencySymbol: "ل.ل",
    currencyName: "Lebanese pound"
  },
  962: {
    country: "Jordan",
    currencyCode: "JOD",
    currencySymbol: "د.ا",
    currencyName: "Jordanian dinar"
  },
  963: {
    country: "Syria",
    currencyCode: "SYP",
    currencySymbol: "£",
    currencyName: "Syrian pound"
  },
  964: {
    country: "Iraq",
    currencyCode: "IQD",
    currencySymbol: "ع.د",
    currencyName: "Iraqi dinar"
  },
  965: {
    country: "Kuwait",
    currencyCode: "KWD",
    currencySymbol: "د.ك",
    currencyName: "Kuwaiti dinar"
  },
  966: {
    country: "Saudi Arabia",
    currencyCode: "SAR",
    currencySymbol: "ر.س",
    currencyName: "Saudi riyal"
  },
  967: {
    country: "Yemen",
    currencyCode: "YER",
    currencySymbol: "﷼",
    currencyName: "Yemeni rial"
  },
  968: {
    country: "Oman",
    currencyCode: "OMR",
    currencySymbol: "ر.ع.",
    currencyName: "Omani rial"
  },
  970: {
    country: "Palestine",
    currencyCode: "EGP",
    currencySymbol: "E£",
    currencyName: "Egyptian pound"
  },
  971: {
    country: "United Arab Emirates",
    currencyCode: "AED",
    currencySymbol: "د.إ",
    currencyName: "United Arab Emirates dirham"
  },
  972: {
    country: "Israel",
    currencyCode: "ILS",
    currencySymbol: "₪",
    currencyName: "Israeli new shekel"
  },
  973: {
    country: "Bahrain",
    currencyCode: "BHD",
    currencySymbol: ".د.ب",
    currencyName: "Bahraini dinar"
  },
  974: {
    country: "Qatar",
    currencyCode: "QAR",
    currencySymbol: "ر.ق",
    currencyName: "Qatari riyal"
  },
  975: {
    country: "Bhutan",
    currencyCode: "BTN",
    currencySymbol: "Nu.",
    currencyName: "Bhutanese ngultrum"
  },
  976: {
    country: "Mongolia",
    currencyCode: "MNT",
    currencySymbol: "₮",
    currencyName: "Mongolian tögrög"
  },
  977: {
    country: "Nepal",
    currencyCode: "NPR",
    currencySymbol: "₨",
    currencyName: "Nepalese rupee"
  },
  992: {
    country: "Tajikistan",
    currencyCode: "TJS",
    currencySymbol: "ЅМ",
    currencyName: "Tajikistani somoni"
  },
  993: {
    country: "Turkmenistan",
    currencyCode: "TMT",
    currencySymbol: "m",
    currencyName: "Turkmenistan manat"
  },
  994: {
    country: "Azerbaijan",
    currencyCode: "AZN",
    currencySymbol: "₼",
    currencyName: "Azerbaijani manat"
  },
  995: {
    country: "Georgia",
    currencyCode: "GEL",
    currencySymbol: "₾",
    currencyName: "lari"
  },
  996: {
    country: "Kyrgyzstan",
    currencyCode: "KGS",
    currencySymbol: "с",
    currencyName: "Kyrgyzstani som"
  },
  998: {
    country: "Uzbekistan",
    currencyCode: "UZS",
    currencySymbol: "so'm",
    currencyName: "Uzbekistani soʻm"
  },
  1201: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1202: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1203: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1204: {
    country: "Canada",
    currencyCode: "CAD",
    currencySymbol: "$",
    currencyName: "Canadian dollar"
  },
  1205: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1206: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1207: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1208: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1209: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1210: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1212: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1213: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1214: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1215: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1216: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1217: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1218: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1219: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1220: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1223: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1224: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1225: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1226: {
    country: "Canada",
    currencyCode: "CAD",
    currencySymbol: "$",
    currencyName: "Canadian dollar"
  },
  1227: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1228: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1229: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1231: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1234: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1236: {
    country: "Canada",
    currencyCode: "CAD",
    currencySymbol: "$",
    currencyName: "Canadian dollar"
  },
  1239: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1240: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1242: {
    country: "Bahamas",
    currencyCode: "BSD",
    currencySymbol: "$",
    currencyName: "Bahamian dollar"
  },
  1246: {
    country: "Barbados",
    currencyCode: "BBD",
    currencySymbol: "$",
    currencyName: "Barbadian dollar"
  },
  1248: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1249: {
    country: "Canada",
    currencyCode: "CAD",
    currencySymbol: "$",
    currencyName: "Canadian dollar"
  },
  1250: {
    country: "Canada",
    currencyCode: "CAD",
    currencySymbol: "$",
    currencyName: "Canadian dollar"
  },
  1251: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1252: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1253: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1254: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1256: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1260: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1262: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1263: {
    country: "Canada",
    currencyCode: "CAD",
    currencySymbol: "$",
    currencyName: "Canadian dollar"
  },
  1264: {
    country: "Anguilla",
    currencyCode: "XCD",
    currencySymbol: "$",
    currencyName: "Eastern Caribbean dollar"
  },
  1267: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1268: {
    country: "Antigua and Barbuda",
    currencyCode: "XCD",
    currencySymbol: "$",
    currencyName: "Eastern Caribbean dollar"
  },
  1269: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1270: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1272: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1274: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1276: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1279: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1281: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1283: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1284: {
    country: "British Virgin Islands",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1289: {
    country: "Canada",
    currencyCode: "CAD",
    currencySymbol: "$",
    currencyName: "Canadian dollar"
  },
  1301: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1302: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1303: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1304: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1305: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1306: {
    country: "Canada",
    currencyCode: "CAD",
    currencySymbol: "$",
    currencyName: "Canadian dollar"
  },
  1307: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1308: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1309: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1310: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1312: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1313: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1314: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1315: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1316: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1317: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1318: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1319: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1320: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1321: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1323: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1325: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1326: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1327: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1330: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1331: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1332: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1334: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1336: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1337: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1339: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1340: {
    country: "United States Virgin Islands",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1341: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1343: {
    country: "Canada",
    currencyCode: "CAD",
    currencySymbol: "$",
    currencyName: "Canadian dollar"
  },
  1345: {
    country: "Cayman Islands",
    currencyCode: "KYD",
    currencySymbol: "$",
    currencyName: "Cayman Islands dollar"
  },
  1346: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1347: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1351: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1352: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1354: {
    country: "Canada",
    currencyCode: "CAD",
    currencySymbol: "$",
    currencyName: "Canadian dollar"
  },
  1360: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1361: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1364: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1365: {
    country: "Canada",
    currencyCode: "CAD",
    currencySymbol: "$",
    currencyName: "Canadian dollar"
  },
  1367: {
    country: "Canada",
    currencyCode: "CAD",
    currencySymbol: "$",
    currencyName: "Canadian dollar"
  },
  1368: {
    country: "Canada",
    currencyCode: "CAD",
    currencySymbol: "$",
    currencyName: "Canadian dollar"
  },
  1380: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1382: {
    country: "Canada",
    currencyCode: "CAD",
    currencySymbol: "$",
    currencyName: "Canadian dollar"
  },
  1385: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1386: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1387: {
    country: "Canada",
    currencyCode: "CAD",
    currencySymbol: "$",
    currencyName: "Canadian dollar"
  },
  1401: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1402: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1403: {
    country: "Canada",
    currencyCode: "CAD",
    currencySymbol: "$",
    currencyName: "Canadian dollar"
  },
  1404: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1405: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1406: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1407: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1408: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1409: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1410: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1412: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1413: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1414: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1415: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1416: {
    country: "Canada",
    currencyCode: "CAD",
    currencySymbol: "$",
    currencyName: "Canadian dollar"
  },
  1417: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1418: {
    country: "Canada",
    currencyCode: "CAD",
    currencySymbol: "$",
    currencyName: "Canadian dollar"
  },
  1419: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1423: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1424: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1425: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1428: {
    country: "Canada",
    currencyCode: "CAD",
    currencySymbol: "$",
    currencyName: "Canadian dollar"
  },
  1430: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1431: {
    country: "Canada",
    currencyCode: "CAD",
    currencySymbol: "$",
    currencyName: "Canadian dollar"
  },
  1432: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1434: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1435: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1437: {
    country: "Canada",
    currencyCode: "CAD",
    currencySymbol: "$",
    currencyName: "Canadian dollar"
  },
  1438: {
    country: "Canada",
    currencyCode: "CAD",
    currencySymbol: "$",
    currencyName: "Canadian dollar"
  },
  1440: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1441: {
    country: "Bermuda",
    currencyCode: "BMD",
    currencySymbol: "$",
    currencyName: "Bermudian dollar"
  },
  1442: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1443: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1445: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1447: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1448: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1450: {
    country: "Canada",
    currencyCode: "CAD",
    currencySymbol: "$",
    currencyName: "Canadian dollar"
  },
  1458: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1463: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1464: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1468: {
    country: "Canada",
    currencyCode: "CAD",
    currencySymbol: "$",
    currencyName: "Canadian dollar"
  },
  1469: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1470: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1473: {
    country: "Grenada",
    currencyCode: "XCD",
    currencySymbol: "$",
    currencyName: "Eastern Caribbean dollar"
  },
  1474: {
    country: "Canada",
    currencyCode: "CAD",
    currencySymbol: "$",
    currencyName: "Canadian dollar"
  },
  1475: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1478: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1479: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1480: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1484: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1500: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1501: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1502: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1503: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1504: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1505: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1506: {
    country: "Canada",
    currencyCode: "CAD",
    currencySymbol: "$",
    currencyName: "Canadian dollar"
  },
  1507: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1508: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1509: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1510: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1512: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1513: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1514: {
    country: "Canada",
    currencyCode: "CAD",
    currencySymbol: "$",
    currencyName: "Canadian dollar"
  },
  1515: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1516: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1517: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1518: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1519: {
    country: "Canada",
    currencyCode: "CAD",
    currencySymbol: "$",
    currencyName: "Canadian dollar"
  },
  1520: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1521: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1522: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1523: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1524: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1525: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1526: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1527: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1528: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1529: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1530: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1531: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1532: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1533: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1534: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1535: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1538: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1539: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1540: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1541: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1542: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1543: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1544: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1545: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1546: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1547: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1548: {
    country: "Canada",
    currencyCode: "CAD",
    currencySymbol: "$",
    currencyName: "Canadian dollar"
  },
  1549: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1550: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1551: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1552: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1553: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1554: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1556: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1557: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1558: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1559: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1561: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1562: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1563: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1564: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1566: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1567: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1569: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1570: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1571: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1572: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1573: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1574: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1575: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1577: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1578: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1579: {
    country: "Canada",
    currencyCode: "CAD",
    currencySymbol: "$",
    currencyName: "Canadian dollar"
  },
  1580: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1581: {
    country: "Canada",
    currencyCode: "CAD",
    currencySymbol: "$",
    currencyName: "Canadian dollar"
  },
  1582: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1584: {
    country: "Canada",
    currencyCode: "CAD",
    currencySymbol: "$",
    currencyName: "Canadian dollar"
  },
  1585: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1586: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1587: {
    country: "Canada",
    currencyCode: "CAD",
    currencySymbol: "$",
    currencyName: "Canadian dollar"
  },
  1588: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1589: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1600: {
    country: "Canada",
    currencyCode: "CAD",
    currencySymbol: "$",
    currencyName: "Canadian dollar"
  },
  1601: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1602: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1603: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1604: {
    country: "Canada",
    currencyCode: "CAD",
    currencySymbol: "$",
    currencyName: "Canadian dollar"
  },
  1605: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1606: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1607: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1608: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1609: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1610: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1612: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1613: {
    country: "Canada",
    currencyCode: "CAD",
    currencySymbol: "$",
    currencyName: "Canadian dollar"
  },
  1614: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1615: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1616: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1617: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1618: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1619: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1620: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1622: {
    country: "Canada",
    currencyCode: "CAD",
    currencySymbol: "$",
    currencyName: "Canadian dollar"
  },
  1623: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1626: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1628: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1629: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1630: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1631: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1633: {
    country: "Canada",
    currencyCode: "CAD",
    currencySymbol: "$",
    currencyName: "Canadian dollar"
  },
  1636: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1639: {
    country: "Canada",
    currencyCode: "CAD",
    currencySymbol: "$",
    currencyName: "Canadian dollar"
  },
  1640: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1641: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1644: {
    country: "Canada",
    currencyCode: "CAD",
    currencySymbol: "$",
    currencyName: "Canadian dollar"
  },
  1646: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1647: {
    country: "Canada",
    currencyCode: "CAD",
    currencySymbol: "$",
    currencyName: "Canadian dollar"
  },
  1649: {
    country: "Turks and Caicos Islands",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1650: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1651: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1655: {
    country: "Canada",
    currencyCode: "CAD",
    currencySymbol: "$",
    currencyName: "Canadian dollar"
  },
  1656: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1657: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1659: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1660: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1661: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1662: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1664: {
    country: "Montserrat",
    currencyCode: "XCD",
    currencySymbol: "$",
    currencyName: "Eastern Caribbean dollar"
  },
  1667: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1669: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1670: {
    country: "Northern Mariana Islands",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1671: {
    country: "Guam",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1672: {
    country: "Canada",
    currencyCode: "CAD",
    currencySymbol: "$",
    currencyName: "Canadian dollar"
  },
  1677: {
    country: "Canada",
    currencyCode: "CAD",
    currencySymbol: "$",
    currencyName: "Canadian dollar"
  },
  1678: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1679: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1680: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1681: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1682: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1683: {
    country: "Canada",
    currencyCode: "CAD",
    currencySymbol: "$",
    currencyName: "Canadian dollar"
  },
  1684: {
    country: "American Samoa",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1688: {
    country: "Canada",
    currencyCode: "CAD",
    currencySymbol: "$",
    currencyName: "Canadian dollar"
  },
  1689: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1700: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1701: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1702: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1703: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1704: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1705: {
    country: "Canada",
    currencyCode: "CAD",
    currencySymbol: "$",
    currencyName: "Canadian dollar"
  },
  1706: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1707: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1708: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1709: {
    country: "Canada",
    currencyCode: "CAD",
    currencySymbol: "$",
    currencyName: "Canadian dollar"
  },
  1710: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1712: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1713: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1714: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1715: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1716: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1717: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1718: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1719: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1720: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1721: {
    country: "Sint Maarten",
    currencyCode: "ANG",
    currencySymbol: "ƒ",
    currencyName: "Netherlands Antillean guilder"
  },
  1724: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1725: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1726: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1727: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1730: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1731: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1732: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1734: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1737: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1740: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1742: {
    country: "Canada",
    currencyCode: "CAD",
    currencySymbol: "$",
    currencyName: "Canadian dollar"
  },
  1743: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1747: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1753: {
    country: "Canada",
    currencyCode: "CAD",
    currencySymbol: "$",
    currencyName: "Canadian dollar"
  },
  1754: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1757: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1758: {
    country: "Saint Lucia",
    currencyCode: "XCD",
    currencySymbol: "$",
    currencyName: "Eastern Caribbean dollar"
  },
  1760: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1762: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1763: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1765: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1767: {
    country: "Dominica",
    currencyCode: "XCD",
    currencySymbol: "$",
    currencyName: "Eastern Caribbean dollar"
  },
  1769: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1770: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1771: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1772: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1773: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1774: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1775: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1778: {
    country: "Canada",
    currencyCode: "CAD",
    currencySymbol: "$",
    currencyName: "Canadian dollar"
  },
  1779: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1780: {
    country: "Canada",
    currencyCode: "CAD",
    currencySymbol: "$",
    currencyName: "Canadian dollar"
  },
  1781: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1782: {
    country: "Canada",
    currencyCode: "CAD",
    currencySymbol: "$",
    currencyName: "Canadian dollar"
  },
  1784: {
    country: "Saint Vincent and the Grenadines",
    currencyCode: "XCD",
    currencySymbol: "$",
    currencyName: "Eastern Caribbean dollar"
  },
  1785: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1786: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1787: {
    country: "Puerto Rico",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1801: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1802: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1803: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1804: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1805: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1806: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1807: {
    country: "Canada",
    currencyCode: "CAD",
    currencySymbol: "$",
    currencyName: "Canadian dollar"
  },
  1808: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1809: {
    country: "Dominican Republic",
    currencyCode: "DOP",
    currencySymbol: "$",
    currencyName: "Dominican peso"
  },
  1810: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1812: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1813: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1814: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1815: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1816: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1817: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1818: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1819: {
    country: "Canada",
    currencyCode: "CAD",
    currencySymbol: "$",
    currencyName: "Canadian dollar"
  },
  1820: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1825: {
    country: "Canada",
    currencyCode: "CAD",
    currencySymbol: "$",
    currencyName: "Canadian dollar"
  },
  1826: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1828: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1829: {
    country: "Dominican Republic",
    currencyCode: "DOP",
    currencySymbol: "$",
    currencyName: "Dominican peso"
  },
  1830: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1831: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1832: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1838: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1839: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1840: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1843: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1845: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1847: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1848: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1849: {
    country: "Dominican Republic",
    currencyCode: "DOP",
    currencySymbol: "$",
    currencyName: "Dominican peso"
  },
  1850: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1854: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1856: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1857: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1858: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1859: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1860: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1862: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1863: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1864: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1865: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1867: {
    country: "Canada",
    currencyCode: "CAD",
    currencySymbol: "$",
    currencyName: "Canadian dollar"
  },
  1868: {
    country: "Trinidad and Tobago",
    currencyCode: "TTD",
    currencySymbol: "$",
    currencyName: "Trinidad and Tobago dollar"
  },
  1869: {
    country: "Saint Kitts and Nevis",
    currencyCode: "XCD",
    currencySymbol: "$",
    currencyName: "Eastern Caribbean dollar"
  },
  1870: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1872: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1873: {
    country: "Canada",
    currencyCode: "CAD",
    currencySymbol: "$",
    currencyName: "Canadian dollar"
  },
  1876: {
    country: "Jamaica",
    currencyCode: "JMD",
    currencySymbol: "$",
    currencyName: "Jamaican dollar"
  },
  1878: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1879: {
    country: "Canada",
    currencyCode: "CAD",
    currencySymbol: "$",
    currencyName: "Canadian dollar"
  },
  1901: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1902: {
    country: "Canada",
    currencyCode: "CAD",
    currencySymbol: "$",
    currencyName: "Canadian dollar"
  },
  1903: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1904: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1905: {
    country: "Canada",
    currencyCode: "CAD",
    currencySymbol: "$",
    currencyName: "Canadian dollar"
  },
  1906: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1907: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1908: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1909: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1910: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1912: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1913: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1914: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1915: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1916: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1917: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1918: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1919: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1920: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1925: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1928: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1929: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1930: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1931: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1934: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1936: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1937: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1938: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1939: {
    country: "Puerto Rico",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1940: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1941: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1942: {
    country: "Canada",
    currencyCode: "CAD",
    currencySymbol: "$",
    currencyName: "Canadian dollar"
  },
  1943: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1945: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1947: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1948: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1949: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1951: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1952: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1954: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1956: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1959: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1970: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1971: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1972: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1973: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1975: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1978: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1979: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1980: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1983: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1984: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1985: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1986: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  1989: {
    country: "United States",
    currencyCode: "USD",
    currencySymbol: "$",
    currencyName: "United States dollar"
  },
  4779: {
    country: "Svalbard and Jan Mayen",
    currencyCode: "NOK",
    currencySymbol: "kr",
    currencyName: "krone"
  },
  35818: {
    country: "Åland Islands",
    currencyCode: "EUR",
    currencySymbol: "€",
    currencyName: "Euro"
  },
  2125288: {
    country: "Western Sahara",
    currencyCode: "DZD",
    currencySymbol: "دج",
    currencyName: "Algerian dinar"
  },
  2125289: {
    country: "Western Sahara",
    currencyCode: "DZD",
    currencySymbol: "دج",
    currencyName: "Algerian dinar"
  },
  3906698: {
    country: "Vatican City",
    currencyCode: "EUR",
    currencySymbol: "€",
    currencyName: "Euro"
  }
};

// Longest key in the table above -- how many leading digits a lookup
// tries before giving up, since a calling code can be 1-7 digits (see
// the Western Sahara / Vatican City note above for why a couple of
// entries run that long).
const MAX_KEY_LENGTH = Math.max(...Object.keys(COUNTRY_CURRENCY_BY_CALLING_CODE).map((k) => k.length));

// Kika's original, single-market default -- used whenever a phone
// number's calling code isn't recognized at all (malformed input, or a
// numbering-plan corner this table doesn't cover) rather than ever
// leaving a merchant with no currency assigned.
const DEFAULT_CURRENCY = { country: 'Nigeria', currencyCode: 'NGN', currencySymbol: '\u20a6', currencyName: 'Nigerian naira' };

/**
 * Tries progressively shorter leading-digit prefixes of `digits`
 * against the table, longest first -- this is what correctly resolves
 * shared-root cases (NANP's +1, Russia/Kazakhstan's +7, Western Sahara
 * inside Morocco, Vatican City inside Italy) without any special-casing
 * here: the table's keys are already exactly as specific as each case
 * needs, so the first (longest) match is always the right one.
 */
function lookupByCallingCodeDigits(digits) {
  const tryLength = Math.min(MAX_KEY_LENGTH, digits.length);
  for (let len = tryLength; len >= 1; len -= 1) {
    const candidate = digits.slice(0, len);
    if (COUNTRY_CURRENCY_BY_CALLING_CODE[candidate]) return COUNTRY_CURRENCY_BY_CALLING_CODE[candidate];
  }
  return null;
}

/**
 * Resolves {country, currencyCode, currencySymbol, currencyName} from a
 * phone number in (or convertible to) E.164 form -- "+2348012345678",
 * "2348012345678", and anything with stray formatting (spaces, dashes)
 * all work, since only the digits are used. Never throws and never
 * returns null/undefined -- an unrecognized or malformed number falls
 * back to DEFAULT_CURRENCY (NGN), Kika's original market, rather than
 * ever leaving a merchant with no currency at all.
 */
function resolveByPhoneNumber(phoneNumber) {
  const digits = String(phoneNumber || '').replace(/[^0-9]/g, '');
  if (!digits) return DEFAULT_CURRENCY;
  return lookupByCallingCodeDigits(digits) || DEFAULT_CURRENCY;
}

/** Plain currencyCode -> {symbol, name} reverse lookup, e.g. for a merchant record that already has a currency code saved but needs its symbol for display. Built from the same table, so it's always in sync. */
const CURRENCY_INFO_BY_CODE = {};
for (const entry of Object.values(COUNTRY_CURRENCY_BY_CALLING_CODE)) {
  if (!CURRENCY_INFO_BY_CODE[entry.currencyCode]) {
    CURRENCY_INFO_BY_CODE[entry.currencyCode] = { symbol: entry.currencySymbol, name: entry.currencyName };
  }
}
CURRENCY_INFO_BY_CODE[DEFAULT_CURRENCY.currencyCode] = { symbol: DEFAULT_CURRENCY.currencySymbol, name: DEFAULT_CURRENCY.currencyName };

/** Symbol for a known currency code, falling back to the code itself (e.g. "XYZ") if somehow unrecognized -- always renders SOMETHING rather than throwing. */
function getCurrencySymbol(currencyCode) {
  return CURRENCY_INFO_BY_CODE[currencyCode]?.symbol || currencyCode;
}

module.exports = {
  COUNTRY_CURRENCY_BY_CALLING_CODE,
  CURRENCY_INFO_BY_CODE,
  DEFAULT_CURRENCY,
  resolveByPhoneNumber,
  getCurrencySymbol,
};
