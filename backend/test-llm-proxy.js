#!/usr/bin/env npx ts-node
"use strict";
/**
 * Diagnostic script to test LLM proxy connection
 * Usage: npx ts-node backend/test-llm-proxy.ts
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config({ path: './backend/.env' });
const config = {
    LLM_PROXY_CHAT_URL: process.env.LLM_PROXY_CHAT_URL || 'https://quasarmarket.coforge.com/qag/llmrouter-api/v2/chat/completions',
    GPT4O_MINI_API_KEY: process.env.GPT4O_MINI_API_KEY || process.env.GPT4O_MINI_MODEL_ID || process.env.OPENAI_API_KEY || '',
    GPT5_MINI_API_KEY: process.env.GPT5_MINI_API_KEY || process.env.GPT5_MINI_MODEL_ID || process.env.OPENAI_API_KEY || '',
};
async function testProxy() {
    console.log('🔍 LLM Proxy Diagnostic Test\n');
    console.log('Configuration:');
    console.log(`  LLM_PROXY_CHAT_URL: ${config.LLM_PROXY_CHAT_URL}`);
    console.log(`  GPT4O_MINI_API_KEY: ${config.GPT4O_MINI_API_KEY ? '✓ Set' : '✗ Missing'} (length: ${config.GPT4O_MINI_API_KEY?.length || 0})`);
    console.log(`  GPT5_MINI_API_KEY: ${config.GPT5_MINI_API_KEY ? '✓ Set' : '✗ Missing'} (length: ${config.GPT5_MINI_API_KEY?.length || 0})\n`);
    if (!config.GPT4O_MINI_API_KEY) {
        console.log('❌ ERROR: No API key configured for GPT4O_MINI');
        process.exit(1);
    }
    try {
        console.log('📡 Testing gpt-4o-mini model...');
        const response = await fetch(config.LLM_PROXY_CHAT_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-API-KEY': config.GPT4O_MINI_API_KEY,
            },
            body: JSON.stringify({
                model: 'gpt-4o-mini',
                messages: [{ role: 'user', content: 'Say hello' }],
                temperature: 0.7,
                top_p: 0.9,
                max_tokens: 100,
            }),
        });
        console.log(`Response Status: ${response.status} ${response.statusText}`);
        console.log(`Content-Type: ${response.headers.get('content-type')}`);
        const text = await response.text();
        const isJson = response.headers.get('content-type')?.includes('application/json');
        const isHtml = text.trim().toLowerCase().startsWith('<');
        if (isHtml) {
            console.log(`\n⚠️  Response is HTML (not JSON):`);
            console.log(text.slice(0, 500));
            console.log('\n❌ ISSUE: Proxy returned HTML instead of JSON');
            console.log('   Check: Is the LLM_PROXY_CHAT_URL correct?');
            console.log('   Check: Is the authentication header correct?');
            console.log('   Check: Is the proxy service running?');
        }
        else if (!isJson && !response.ok) {
            console.log(`\n⚠️  Response is not JSON:`);
            console.log(text.slice(0, 500));
        }
        else {
            try {
                const data = JSON.parse(text);
                if (response.ok) {
                    console.log('\n✅ Proxy is working correctly!');
                    console.log('Response:', JSON.stringify(data, null, 2).slice(0, 300));
                }
                else {
                    console.log('\n⚠️  API returned error:');
                    console.log('Response:', JSON.stringify(data, null, 2).slice(0, 500));
                }
            }
            catch (e) {
                console.log('\n❌ Response is not valid JSON:', text.slice(0, 200));
            }
        }
    }
    catch (err) {
        console.log(`\n❌ Network Error: ${err instanceof Error ? err.message : String(err)}`);
        console.log('Check: Is the proxy URL reachable?');
        console.log('Check: Do you have network connectivity?');
    }
}
testProxy().catch(console.error);
