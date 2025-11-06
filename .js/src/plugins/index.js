"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
var Syosetu_1 = __importDefault(require("@plugins/japanese/Syosetu"));
var kakuyomu_1 = __importDefault(require("@plugins/japanese/kakuyomu"));
var PLUGINS = [Syosetu_1.default, kakuyomu_1.default];
exports.default = PLUGINS;
