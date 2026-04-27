"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerFrontendProxy = registerFrontendProxy;
const http_proxy_1 = __importDefault(require("@fastify/http-proxy"));
async function registerFrontendProxy(fastify) {
    fastify.register(http_proxy_1.default, {
        upstream: 'http://localhost:3001', // Change to your frontend dev server
        prefix: '/app',
        rewritePrefix: '/app',
    });
}
