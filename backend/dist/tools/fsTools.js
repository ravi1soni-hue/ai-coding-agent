"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.readFile = readFile;
exports.writeFile = writeFile;
exports.fileExists = fileExists;
exports.deleteFile = deleteFile;
// File system tools
const promises_1 = __importDefault(require("fs/promises"));
async function readFile(path) {
    return promises_1.default.readFile(path, 'utf-8');
}
async function writeFile(path, data) {
    return promises_1.default.writeFile(path, data, 'utf-8');
}
async function fileExists(path) {
    try {
        await promises_1.default.access(path);
        return true;
    }
    catch {
        return false;
    }
}
async function deleteFile(path) {
    await promises_1.default.unlink(path);
}
