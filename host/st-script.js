import * as scriptApi from "../../../../../script.js";

export const eventSource = scriptApi.eventSource;
export const event_types = scriptApi.event_types;
export const extension_prompt_roles = scriptApi.extension_prompt_roles;
export const extension_prompt_types = scriptApi.extension_prompt_types;
export const getRequestHeaders = scriptApi.getRequestHeaders;
export const saveMetadata = scriptApi.saveMetadata;
export const saveSettingsDebounced = scriptApi.saveSettingsDebounced;
export const substituteParamsExtended =
  scriptApi.substituteParamsExtended || ((text) => text);
