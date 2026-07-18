'use strict';

const logger = require('../utils/logger');

/**
 * Fixed category enums. Kept small and merchant-facing-friendly (these
 * may eventually surface in reports/analytics), not an exhaustive
 * taxonomy — "Other" is always a safe landing spot rather than forcing a
 * bad-fit classification.
 */
const BUSINESS_CATEGORIES = [
  'Retail',
  'Wholesale',
  'Food & Beverage',
  'Fashion & Apparel',
  'Beauty & Personal Care',
  'Electronics & Gadgets',
  'Agriculture',
  'Manufacturing & Production',
  'Services',
  'Other',
];

const EXPENSE_CATEGORIES = [
  'Inventory & Stock',
  'Transport & Logistics',
  'Rent & Utilities',
  'Salaries & Wages',
  'Marketing & Advertising',
  'Equipment & Supplies',
  'Fees & Charges',
  'Food & Refreshments',
  'Other',
];

// --- Keyword-first pass: instant, free, no AI round-trip for the common
// cases a merchant's own wording usually makes obvious. ---------------
const BUSINESS_CATEGORY_KEYWORDS = [
  { category: 'Wholesale', keywords: ['wholesale', 'distributor', 'bulk supply', 'supplier'] },
  { category: 'Food & Beverage', keywords: ['restaurant', 'food', 'eatery', 'canteen', 'catering', 'drinks', 'bar', 'suya', 'bakery', 'confectionery', 'snack'] },
  { category: 'Fashion & Apparel', keywords: ['fashion', 'clothing', 'clothes', 'boutique', 'tailoring', 'tailor', 'fabric', 'shoe', 'bag', 'ankara', 'lace'] },
  { category: 'Beauty & Personal Care', keywords: ['beauty', 'salon', 'barbing', 'barber', 'spa', 'cosmetics', 'makeup', 'skincare', 'hair'] },
  { category: 'Electronics & Gadgets', keywords: ['electronics', 'phone', 'gadget', 'computer', 'accessories', 'laptop', 'gsm'] },
  { category: 'Agriculture', keywords: ['farm', 'agriculture', 'agro', 'poultry', 'livestock', 'crop'] },
  { category: 'Manufacturing & Production', keywords: ['manufactur', 'factory', 'production', 'fabrication', 'workshop'] },
  { category: 'Services', keywords: ['service', 'repair', 'consult', 'laundry', 'cleaning', 'logistics', 'delivery', 'transport'] },
  { category: 'Retail', keywords: ['provision', 'store', 'shop', 'supermarket', 'kiosk', 'mini mart', 'general goods', 'stall'] },
];

const EXPENSE_CATEGORY_KEYWORDS = [
  { category: 'Inventory & Stock', keywords: ['stock', 'inventory', 'goods', 'restock', 'supply', 'raw material', 'purchase of'] },
  { category: 'Transport & Logistics', keywords: ['transport', 'fuel', 'petrol', 'diesel', 'fare', 'logistics', 'delivery', 'uber', 'bolt', 'bike', 'okada'] },
  { category: 'Rent & Utilities', keywords: ['rent', 'electricity', 'nepa', 'phcn', 'water bill', 'utility', 'utilities', 'generator', 'gen fuel'] },
  { category: 'Salaries & Wages', keywords: ['salary', 'wage', 'staff pay', 'worker pay', 'allowance'] },
  { category: 'Marketing & Advertising', keywords: ['advert', 'marketing', 'promo', 'flyer', 'sponsor', 'boost post'] },
  { category: 'Equipment & Supplies', keywords: ['equipment', 'tools', 'machine', 'repair', 'maintenance', 'packaging', 'nylon', 'carton'] },
  { category: 'Fees & Charges', keywords: ['fee', 'charge', 'levy', 'tax', 'bank charge', 'transfer charge', 'commission'] },
  { category: 'Food & Refreshments', keywords: ['food', 'lunch', 'snack', 'drink', 'refreshment'] },
];

function matchByKeywords(text, table) {
  const lower = String(text || '').toLowerCase();
  if (!lower.trim()) return null;
  for (const entry of table) {
    if (entry.keywords.some((k) => lower.includes(k))) return entry.category;
  }
  return null;
}

function hasAiProviderConfigured() {
  return Boolean(process.env.OPENAI_API_KEY || process.env.GEMINI_API_KEY);
}

/**
 * Small, single-purpose tool schema for the AI fallback — deliberately
 * separate from RECORD_TRANSACTION_TOOL in aiTransactionParser.js, since
 * this is a plain classification call with no money/entry semantics.
 */
function buildClassifyTool(categories, subject) {
  return {
    type: 'function',
    function: {
      name: 'classify_category',
      description: `Classify the ${subject} into exactly one of the provided categories. Pick "Other" only if genuinely none of the specific categories fit.`,
      parameters: {
        type: 'object',
        properties: {
          category: { type: 'string', enum: categories },
        },
        required: ['category'],
      },
    },
  };
}

async function classifyWithAI({ text, categories, subject, systemPrompt }) {
  if (!hasAiProviderConfigured() || !text) return null;
  try {
    // Lazy require to avoid a require-cycle with services that themselves
    // depend on categorizationService in the future.
    const openaiService = require('./openaiService');
    const { toolCall } = await openaiService.chatCompletion({
      systemPrompt,
      userText: text,
      tools: [buildClassifyTool(categories, subject)],
    });
    const category = toolCall?.arguments?.category;
    return categories.includes(category) ? category : null;
  } catch (err) {
    logger.error({ err: err.message, subject }, 'AI categorization fallback failed');
    return null;
  }
}

/**
 * Classifies a merchant's own description of their business type (e.g.
 * "Provision Store", "I sell phones and accessories") into one fixed
 * business_category. Keyword pass first (instant, free); AI fallback
 * only when nothing matched and an AI provider is configured. Never
 * throws — worst case, returns 'Other' rather than blocking onboarding.
 */
async function categorizeBusinessType(businessType, businessName) {
  const combined = `${businessType || ''} ${businessName || ''}`;
  const keywordMatch = matchByKeywords(combined, BUSINESS_CATEGORY_KEYWORDS);
  if (keywordMatch) return keywordMatch;

  const aiMatch = await classifyWithAI({
    text: `Business name: ${businessName || 'Unknown'}\nBusiness type as described by the merchant: ${businessType || 'Unknown'}`,
    categories: BUSINESS_CATEGORIES,
    subject: 'business',
    systemPrompt:
      'You classify a small Nigerian merchant business into exactly one fixed category based on its name and the type of business the owner described. Respond only by calling classify_category.',
  });

  return aiMatch || 'Other';
}

/**
 * Classifies a DEBIT (expense) entry's description/item into one fixed
 * expense_category. Same keyword-first, AI-fallback shape as above.
 */
async function categorizeExpense(description, itemName) {
  const combined = `${description || ''} ${itemName || ''}`;
  const keywordMatch = matchByKeywords(combined, EXPENSE_CATEGORY_KEYWORDS);
  if (keywordMatch) return keywordMatch;

  const aiMatch = await classifyWithAI({
    text: description || itemName || '',
    categories: EXPENSE_CATEGORIES,
    subject: 'expense',
    systemPrompt:
      'You classify a small Nigerian merchant\'s business expense into exactly one fixed category based on its description. Respond only by calling classify_category.',
  });

  return aiMatch || 'Other';
}

module.exports = {
  BUSINESS_CATEGORIES,
  EXPENSE_CATEGORIES,
  categorizeBusinessType,
  categorizeExpense,
};
