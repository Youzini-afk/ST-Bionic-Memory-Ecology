// ST-BME: 闂傚倸鍊烽懗鍫曞箠閹剧粯鍊舵繝闈涚墢閻捇鏌ｉ姀鐘典粵闁哄棙绮撻弻娑㈩敃閿濆棛顦ㄥ銈冨劚閻楁捇寮婚弴锛勭杸濠电姴鍊搁埛澶岀磽娴ｈ棄鐓愮憸鏉垮暣濠€浣糕攽閻樻瑥鍟版禒銏ゆ煃瑜滈崜姘跺箰妤ｅ啯鍤嶉弶鍫涘妼椤曢亶鎮楀☉娆樼劷闁告梻鏁诲娲传閸曨偒浠肩紓浣虹帛鐢偤寮?

import { GraphRenderer } from "./graph-renderer.js";
import { getNodeDisplayName } from "../graph/node-labels.js";
import {
  buildRegionLine,
  buildScopeBadgeText,
  normalizeMemoryScope,
} from "../graph/memory-scope.js";
import { listKnowledgeOwners } from "../graph/knowledge-state.js";
import { getHostUserAliasHints } from "../runtime/user-alias-utils.js";
import {
  describeNodeStoryTime,
  describeStoryTime,
  describeStoryTimeSpan,
} from "../graph/story-timeline.js";
import {
  compareSummaryEntriesForDisplay,
  getActiveSummaryEntries,
  getSummaryEntriesByStatus,
} from "../graph/summary-state.js";
import {
  resolveActiveLlmPresetName,
  sanitizeLlmPresetSettings,
} from "../llm/llm-preset-utils.js";
import {
  cloneTaskProfile,
  createDefaultGlobalTaskRegex,
  createBuiltinPromptBlock,
  createCustomPromptBlock,
  createLocalRegexRule,
  DEFAULT_TASK_BLOCKS,
  dedupeRegexRules,
  ensureTaskProfiles,
  exportTaskProfile as serializeTaskProfile,
  getBuiltinBlockDefinitions,
  getLegacyPromptFieldForTask,
  getTaskTypeOptions,
  importTaskProfile as parseImportedTaskProfile,
  isTaskRegexStageEnabled,
  migrateLegacyProfileRegexToGlobal,
  normalizeGlobalTaskRegex,
  normalizeTaskRegexStages,
  restoreDefaultTaskProfile,
  setActiveTaskProfileId,
  upsertTaskProfile,
} from "../prompting/prompt-profiles.js";
import { getNodeColors } from "./themes.js";
import {
  getSuggestedBackendModel,
  getVectorIndexStats,
} from "../vector/vector-index.js";

let defaultPromptCache = null;

function getDefaultPrompts() {
  if (defaultPromptCache) {
    return defaultPromptCache;
  }

  const prompts = {};
  for (const [key, block] of Object.entries(DEFAULT_TASK_BLOCKS || {})) {
    prompts[key] = [block?.role, block?.format, block?.rules]
      .filter(Boolean)
      .join("\n\n");
  }

  defaultPromptCache = prompts;
  return prompts;
}

function getDefaultPromptText(taskType = "") {
  return getDefaultPrompts()[taskType] || "";
}

const TASK_PROFILE_TABS = [
  { id: "generation", label: "闂傚倸鍊烽悞锕傛儑瑜版帒鍨傚┑鐘宠壘缁愭鏌熼悧鍫熺凡闁搞劌鍊归幈銊ノ熼幐搴ｃ€愰梺娲诲幗椤ㄥ﹪寮诲☉姘勃闁告挆鈧慨鍥р攽? },
  { id: "prompt", label: "Prompt 缂傚倸鍊搁崐鎼佸磹閹间礁纾圭憸鐗堝笚閸嬪淇婇妶鍛殲闁? },
  { id: "debug", label: "闂傚倷娴囧畷鍨叏閹绢噮鏁勯柛娑欐綑閻ゎ噣鏌熼幆鏉啃撻柛搴★攻閵囧嫰寮介妸銉ユ灆缂備焦鍞荤紞渚€寮诲☉銏犲嵆闁靛鍎查悵顔尖攽? },
];

const TASK_PROFILE_ROLE_OPTIONS = [
  { value: "system", label: "system" },
  { value: "user", label: "user" },
  { value: "assistant", label: "assistant" },
];

const TASK_PROFILE_INJECTION_OPTIONS = [
  { value: "append", label: "闂傚倷绀侀幖顐λ囬锕€鐤鹃柣鎰棘濞戙垹绀嬫い鎺嶇瀵? },
  { value: "prepend", label: "闂傚倸鍊风粈渚€骞夐敓鐘茬闁告縿鍎抽惌鎾绘煕椤愶絾绀冮柛? },
  { value: "relative", label: "闂傚倸鍊烽懗鍫曞磿閻㈢鐤炬繝闈涱儌閳ь剨绠撳畷濂稿Ψ椤旇姤娅? },
];

const TASK_PROFILE_BOOLEAN_OPTIONS = [
  { value: "", label: "闂傚倷娴囧畷鍨叏閹€鏋嶉柨婵嗩槸缁愭鏌″畵顔瑰亾闁哄妫冮弻鏇＄疀婵犲喚娼戝┑鐐存崄閸╂牗绌辨繝鍥舵晬婵炴垵宕崝宀勬⒑? },
  { value: "true", label: "闂備浇顕х€涒晠顢欓弽顓炵獥闁圭儤顨呯壕濠氭煙閸撗呭笡闁? },
  { value: "false", label: "闂傚倸鍊烽懗鍫曗€﹂崼銏″床闁瑰鍋熺粻鎯р攽閻樿弓杩? },
];

const GRAPH_WRITE_ACTION_IDS = [
  "bme-act-extract",
  "bme-act-compress",
  "bme-act-sleep",
  "bme-act-synopsis",
  "bme-act-summary-rollup",
  "bme-act-summary-rebuild",
  "bme-act-summary-clear",
  "bme-act-evolve",
  "bme-act-undo-maintenance",
  "bme-act-import",
  "bme-act-rebuild",
  "bme-act-vector-rebuild",
  "bme-act-vector-range",
  "bme-act-vector-reembed",
  "bme-act-reroll",
  "bme-detail-delete",
  "bme-detail-save",
  "bme-cog-region-apply",
  "bme-cog-region-clear",
  "bme-cog-adjacency-save",
  "bme-cog-story-time-apply",
  "bme-cog-story-time-clear",
];

const TASK_PROFILE_GENERATION_GROUPS = [
  {
    title: "API 闂傚倸鍊搁崐鐑芥倿閿曗偓椤灝螣閼测晝鐓嬮梺鍓插亝濞叉﹢宕?,
    fields: [
      {
        key: "llm_preset",
        label: "API 闂傚倸鍊搁崐鐑芥倿閿曗偓椤灝螣閼测晝鐓嬮梺鍓插亝濞叉﹢宕戦鍫熺厱闁斥晛鍟ㄦ禍妤呮煟閺冨倸甯堕柣鎺撴そ閺屾盯骞囬妸锔界彇闂?,
        type: "llm_preset",
        defaultValue: "",
        help: "闂傚倸鍊峰鎺旀椤旀儳绶ゅΔ锝呭暞閸嬶紕鎲搁弮鍫濇槬闁绘劕鎼崘鈧銈嗗姧缁茶姤绂掗幒妤佲拺闂傚牊涓瑰☉娆愬濡炲閰ｉ埞蹇涙⒒娴ｈ棄鍚瑰┑顔藉劤閳诲秹鏁愭径濠勭崶闂佸搫璇為埀顒勫几閺冨牊鐓忛煫鍥ュ劤缁佸嘲霉濠婂啰绉洪柡宀€鍠栭獮鍡氼槻闁哄棜椴搁妵?API闂傚倸鍊烽悞锔锯偓绗涘懐鐭欓柟鐑橆殕閸庡孩銇勯弽顐粶闁绘帒鐏氶妵鍕箳閸℃ぞ澹曟俊鐐€х€靛矂宕抽敐澶婄疇婵炲棙鎸哥粻锝嗙節閸偄濮囬柡鍛█濮婄粯绻濇惔鈥茶埅闂佸憡锚婢х晫鍒掔紒妯碱浄閻庯綆鍋勯埀顒€鐏氱换娑㈠箣閻戝棔绱楅梺纭呮彧缁蹭粙寮抽悙鐑樷拻濞达絽鎲￠幆鍫熴亜閿旇鐏﹂柟顔矫埞鎴犫偓锝庝簽閻ｅ搫鈹戞幊閸婃洟骞婅箛娑樼柧妞ゆ帒鍊甸崑鎾诲礂婢跺﹣澹曢梻浣告啞閸旓附绂嶉悙渚晩闁归偊鍘剧粻楣冩煙鐎电浠﹂柟顖氬闇夋繝濠傚閹冲洦顨ラ悙鏉戠伌濠殿喒鍋撻梺闈涚墕閹虫劙藝椤曗偓濮婃椽鎮欓挊澶婂Г闁诲繐绻戦悷褏鍒掗敐鍛傛棃宕ㄩ鎯у箺婵犵數鍋涘Λ娆撴晪婵犫拃鍌氬祮闁哄矉绲介埞鎴﹀炊閳规儳顫岄梻浣烘嚀閸㈡煡骞婇幇鏉跨闁告洦鍨版儫闂佹寧妫佹慨銈夘敇瑜版帗鈷掗柛灞剧懅鐠愪即鏌涘▎蹇曠鐎垫澘锕ョ粋鎺斺偓锝冨妷閸?URL / Key / Model闂?,
      },
    ],
  },
  {
    title: "闂傚倸鍊烽懗鍓佹兜閸洖鐤鹃柣鎰ゴ閺嬪秹鏌ㄥ┑鍡╂Ф闁逞屽厸缁舵艾鐣烽妸褉鍋撳☉娅亝绂掑ú顏呪拺缂備焦蓱閳锋帗銇勯鐐靛ⅵ闁诡喗锕㈠畷鍫曨敆娴ｅ搫骞堟繝鐢靛仜濡鎹㈤幇鏉跨劦妞ゆ巻鍋撶紓宥咃工椤?,
    fields: [
      { key: "max_context_tokens", label: "闂傚倸鍊风粈渚€骞栭锔藉亱闁告劦鍠栫壕濠氭煙閻愵剙澧柣鏂挎閺屾盯顢曢姀鈽嗘闂佺锕ら…鐑藉箖閻戣棄绠涙い鎴ｅГ椤秹姊洪崷顓炰壕闁告挻宀稿畷鏇㈠箛閻楀牏鍘?Tokens", type: "number", defaultValue: "" },
      { key: "max_completion_tokens", label: "闂傚倸鍊风粈渚€骞栭锔藉亱闁告劦鍠栫壕濠氭煙閻愵剙澧柣鏂挎閺屾盯顢曢姀鈽嗘闂佸搫鑻幊蹇擃嚗閸曨垰绠涙い鎺戝亞濡?Tokens", type: "number", defaultValue: "" },
      { key: "reply_count", label: "闂傚倸鍊烽悞锕傚箖閸洖纾块柟鎯版绾剧粯绻涢幋鏃€鍤嶉柛銉墮缁犵敻鏌熼崫鍕棡闁诲骸顭峰娲棘閵夛附鐝旈梺鍝ュ櫏閸ㄤ即鍩?, type: "number", defaultValue: 1 },
      { key: "stream", label: "婵犵數濮烽弫鎼佸磻閻旂儤宕叉繝闈涚墢閻棗霉閿濆洤鍔嬫い顐ｆ礋閺屽秹鍩℃担鍛婃缂傚倸绉村ú顓㈠蓟閻旂厧绠氱憸宥夊汲鏉堛劍鍙?, type: "tri_bool", defaultValue: false },
      { key: "temperature", label: "婵犵數濮烽弫鎼佸磻閻愬搫绠伴柟缁㈠枛閻ょ偓绻涢幋鐐茬劰闁?(Temperature)", type: "range", min: 0, max: 2, step: 0.01, defaultValue: 1 },
      { key: "top_p", label: "Top P", type: "range", min: 0, max: 1, step: 0.01, defaultValue: 1 },
      { key: "top_k", label: "Top K", type: "number", defaultValue: 0 },
      { key: "top_a", label: "Top A", type: "range", min: 0, max: 1, step: 0.01, defaultValue: 0 },
      { key: "min_p", label: "Min P", type: "range", min: 0, max: 1, step: 0.01, defaultValue: 0 },
      { key: "seed", label: "闂傚倸鍊搁崐鎼佸磹閹间礁绠犻幖杈剧稻瀹曟煡鏌熺€涙濡囬柡鈧敃鍌涚厓鐟滄粓宕滃☉姘潟闁圭儤鎸哥欢鐐测攽閻樻彃鐝旈柕蹇嬪€栭悡?(Seed)", type: "number", defaultValue: "" },
    ],
  },
  {
    title: "闂傚倸鍊峰ù鍥敋閺嶎厼鍨傛い蹇撶墕閻ょ偓绻濋棃娑氬ⅱ缂佲偓婵犲洦鐓欓柣鎴烇供濞堟棃鏌ｉ鐕佹疁闁哄本绋撴禒锕傚礈瑜夋慨鍥р攽?,
    fields: [
      { key: "frequency_penalty", label: "濠电姷顣藉Σ鍛村磻閸℃ɑ娅犳俊銈呮噹閸ㄥ倿鏌ｉ悢鐓庝喊闁哥喎鎳庨埞鎴﹀磼濠婂海鍔哥紓浣哄У瀹€鎼佸蓟瀹ュ浼犻柛鏇ㄥ亝濞堝墎绱?, type: "range", min: -2, max: 2, step: 0.01, defaultValue: 0 },
      { key: "presence_penalty", label: "闂傚倷娴囬褏鈧稈鏅濈划娆撳箳濡や焦娅斿┑鐘垫暩婵參宕戦幘娣簻闊洦鎸炬晶鏇犵磼閻樺啿鍝洪柡灞界Ч瀹曨偊宕熼锝嗩啀缂?, type: "range", min: -2, max: 2, step: 0.01, defaultValue: 0 },
      { key: "repetition_penalty", label: "闂傚倸鍊搁崐鐑芥倿閿曚降浜归柛鎰典簽閻捇鏌熺紒銏犳殙闁搞儺鍓欓拑鐔兼煏婢跺牆鍔ら柣锝夌畺濮婃椽宕橀崣澶嬪創闂佸摜鍠愭竟鍡欏垝?, type: "range", min: 0, max: 3, step: 0.01, defaultValue: 1 },
    ],
  },
  {
    title: "闂傚倷娴囧畷鐢稿磻閻愮數鐭欓柟瀵稿仧闂勫嫰鏌￠崘銊モ偓鍦偓姘煼閺岋綁寮崒姘粯闂佹椿鍘介〃濠囧蓟濞戞矮娌柛鎾椻偓婵洤鈹?,
    fields: [
      { key: "squash_system_messages", label: "闂傚倸鍊风粈渚€骞夐敓鐘冲殞濡わ絽鍟崑瀣煕閳╁啰鈯曢柛銈嗗姍閺岋綁寮幐搴㈠創闁诲骸鐏氶悡锟犲蓟閵堝棙鍙忛柟閭﹀厴閸嬫挸螖閸涱厽妲梺缁樏壕顓犵不妤ｅ啯鐓欓悗娑欘焽缁犳ê顭胯缁嬫垿婀?, type: "tri_bool", defaultValue: false },
      {
        key: "reasoning_effort",
        label: "闂傚倸鍊峰ù鍥綖婢跺顩插ù鐘差儏缁€澶愬箹濞ｎ剙濡肩紒鐘崇墪閳规垿鎮╅幓鎺嶇敖闂佹悶鍊栧ú鐔煎蓟濞戞ǚ鏀介柛鈩冾殢娴犵厧顪?,
        type: "enum",
        options: [
          { value: "", label: "闂傚倷娴囧畷鍨叏閹€鏋嶉柨婵嗩槸缁愭鏌″畵顔瑰亾闁哄妫冮弻鏇＄疀婵犲喚娼戝┑鐐存崄閸╂牗绌辨繝鍥舵晬婵炴垵宕崝宀勬⒑? },
          { value: "minimal", label: "闂傚倸鍊风粈渚€骞栭锔藉亱闁告劦鍠栫壕濠氭煙閹规劗袦? },
          { value: "low", label: "濠? },
          { value: "medium", label: "濠? },
          { value: "high", label: "濠? },
        ],
        defaultValue: "",
      },
      { key: "request_thoughts", label: "闂傚倷娴囧畷鍨叏閺夋嚚娲敇閵忕姷鍝楅梻渚囧墮缁夌敻宕曢幋婢濆綊宕楅崗鑲╃▏缂備胶濮甸崹鍓佹崲濠靛顥堟繛娣劚閻楁挸鐣烽幋锕€绠婚悹鍥皺椤︺劌顪冮妶鍡樺暗濠殿喚鍏橀幃楣冩惞閸︻厾锛?, type: "tri_bool", defaultValue: false },
      { key: "enable_function_calling", label: "闂傚倸鍊风粈渚€骞夐敓鐘插瀭闁稿繐鍚嬮崣蹇涙煏閸繍妲告慨瑙勭叀閺岋綁寮崒姘闁诲孩鍑归崜鐔煎蓟濞戙垹绠涢柛蹇撴憸閸戝綊姊?, type: "tri_bool", defaultValue: false },
      { key: "enable_web_search", label: "缂傚倸鍊搁崐鎼佸磹閹间礁鐤い鏍仜閸ㄥ倿鏌涜椤ㄥ懓绻氬┑鐘灱閸╂牠宕濋弴鐘典笉閻熸瑥瀚弧鈧繝鐢靛Т閸婂綊宕宠ぐ鎺撶厱?, type: "tri_bool", defaultValue: false },
      { key: "character_name_prefix", label: "闂傚倷娴囧畷鐢稿窗閹扮増鍋￠柨鏃傚亾閺嗘粓鏌ｉ弬鎸庢喐闁绘繆娉涢埞鎴︽偐閸欏鎮欓柣鐔哥懕婵″洭鍩€椤掆偓缁犲秹宕曢柆宥呯疇閹兼惌鐓€閻戣棄宸濇い鏍ㄧ矌閿涙繈姊虹粙鎸庢拱妞ゃ劌鎳忕粋?, type: "text", defaultValue: "" },
      { key: "wrap_user_messages_in_quotes", label: "闂傚倸鍊烽悞锕€顪冮崹顕呯劷闁秆勵殔缁€澶屸偓骞垮劚椤︻垶寮伴妷锔剧闁瑰鍊戝顑╋綁宕奸妷锔惧幈濡炪倖鍔戦崐鏇㈠几瀹ュ洨纾奸弶鍫涘妿婢х敻鏌＄仦鍓ф创鐎殿噮鍣ｅ畷鎺懶掔憗銈呯伄缂佽鲸甯￠獮宥嗘媴鐟欏嫮褰嬮柣?, type: "tri_bool", defaultValue: false },
    ],
  },
];

const TASK_PROFILE_INPUT_GROUPS = {
  synopsis: [
    {
      title: "闂傚倸鍊峰ù鍥敋閺嶎厼绀堟繝闈涙閺嗭箓鏌ｉ姀銈嗘锭闁搞劍绻堥弻鏇熺節韫囨稒顎嶇紓鍌氱Т濞差參寮婚悢鐓庣畾鐟滃秹寮虫潏鈹惧亾?,
      fields: [
        {
          key: "rawChatContextFloors",
          label: "濠电姷顣藉Σ鍛村磻閸℃ɑ娅犳俊銈呭暞瀹曟煡鏌涘畝鈧崐娑㈠炊閵娧呯槇濠殿喗锕╅崜娆撳磻瀹ュ鈷戠紓浣股戦悡銉╂煙鐠囇呯瘈闁诡喗顨婇、娆戜焊閺嶎煈娼旈梻浣烘嚀婢т粙顢楅幓鎺濇綎婵°倕鍟扮壕鍏间繆閵堝倸浜鹃梺纭呮珪閿氭い鏇秮椤㈡宕熼銈呪偓鐐烘⒑闂堟侗鐓紒鑼跺Г缁傛帟銇愰幒鎾跺幗?,
          type: "number",
          defaultValue: 0,
          help: "闂傚倸鍊风欢姘焽閼姐倖瀚婚柣鏃傚帶缁€澶愭倵閿濆骸鍘撮柛瀣崌濡啫鈽夊鍐句純闂備礁鐤囧Λ鍕囬棃娑氭殾濠靛倸鎲￠崑鍕煕閹捐尪鍏屾い锔哄劦濮婄粯鎷呴挊澶夋睏闂佸憡顭嗛崶褏鏌堝銈嗗姀閹稿苯煤椤忓嫮顔囬柟鑹版彧缁叉椽寮稿▎鎾寸厽閹兼惌鍨崇粔闈浢瑰鍡樼【閾伙綁鏌涢埄鍐︿簵婵炴垯鍨洪崑瀣煕椤愮姴鐏柣锝夋涧椤啴濡惰箛鏇犳殺閻庤娲滈弫濠氱嵁閸愨晛顕遍柡澶嬪殾閵娾晜鐓忓鑸得弸鐔兼煃鐠囧眰鍋㈤柡宀嬬秬缁犳盯骞橀崜渚囧敼闂備焦鎮堕崝宀勬偉閸忛棿绻嗛柤鍝ユ暩闂勫嫮绱掔€ｎ亞浠㈤柛瀣Ч濮婅櫣绱掑Ο鑽ゅ弳闂佺顕滅换婵嬪箖濡ゅ拋鏁婇悘蹇旂墬椤秹姊洪悷鏉库挃妞ゆ帗褰冮～蹇撐旈崘顏嗭紲濠德板€愰崑鎾绘煙閾忣個顏堫敋閿濆鏁嗛柛鏇ㄥ亞閸婄偞淇婇悙宸剰婵炲鍏樿棟妞ゆ洍鍋撴慨濠冩そ瀹曘劍绻濋崟顒€娅у┑鐐茬摠缁秶鍒掑鍥╃处濞寸姴顑呴崘鈧銈嗘尵閸嬫妲愰崼鏇熷€垫鐐茬仢閸旀岸鏌熼搹顐㈠鐞氭瑩鏌涢鐘插姕闁绘挻鐟﹂妵鍕箳閹存繃娈梺鍛婅壘濠€杈╂閹烘鏁婇柛婵嗗椤绱撴担绋库偓鍦暜閻愬搫绠柣妯款嚙缁犵敻鏌熼悜妯肩畺闁告牜濞€濮?,
        },
        {
          key: "rawChatSourceMode",
          label: "闂傚倸鍊风粈渚€骞夐敓鐘偓锕傚炊椤掆偓缁愭鏌熼悧鍫熺凡闁告垹濞€閺屾盯骞囬棃娑欑亪缂備胶瀚忛崶銊у帾婵犮垼鍩栫粙鎴︺€呴鍕厽闁哄稁鍓熼崫鍝勄庨崶褝韬い銏＄☉椤啰鎷犻煫顓烆棜闁诲氦顫夊ú鏍洪妸鈹库偓?,
          type: "enum",
          options: [
            { value: "ignore_bme_hide", label: "闂傚倸鍊搁…顒勫磻閸曨個娲Ω閳轰胶鏌у銈嗗姧缁犳垵效?BME 闂傚倸鍊搁崐鎼佸磹閹间礁绠犻煫鍥ㄧ☉缁€澶嬩繆椤栨瑧绉挎繛鎴烆焽閺嗗棝鏌涢弴銊ヤ簽妞わ富鍣ｅ娲礃閸欏鍎撻梺绋匡攻閹倽鐭? },
          ],
          defaultValue: "ignore_bme_hide",
          help: "闂傚倸鍊烽悞锕傚箖閸洖纾块梺顒€绉寸粻瑙勩亜閹板爼妾柛瀣ф櫊閺屾盯骞樺Δ鈧幊鎰版晬濠婂牊鈷戦柛婵嗗缁侇偆绱掓潏銊︾缂?BME 闂傚倸鍊烽懗鍫曞储瑜旈妴鍐╂償閵忋埄娲稿┑鐘诧工閹冲繐鐣烽幓鎺嬧偓鎺戭潩閿濆懍澹曢梻浣筋嚃閸ㄤ即宕弶鎴犳殾闁绘梻鈷堥弫宥嗙箾閹存繂鑸归柟顔肩墦濮婄粯鎷呴挊澹捇鏌ㄥ杈╃＜缂備焦锚婵牓鏌熸笟鍨妞ゃ垺妫冨畷鐓庘攽閸偄鎮戦梻浣筋嚙閸戠晫绱為崱娑樼煑閹肩补妲呭鏍煕瑜庨〃鍡涙偂閺囥垺鐓欓柛顭戝枛閺嗘洟鏌熼鑲┬ょ紒杈ㄥ笚濞煎繘濡歌閻ゅ嫰鎮楃憴鍕┛缂傚秳绶氶妴渚€寮崼婵嗚€垮┑鈽嗗灣缁垶顢橀悷鎵虫斀闁绘劘灏欓幗鐘电磼椤斿吋婀版い銊ｅ劦楠炴牗鎷呴悷鏉垮婵＄偑鍊栫敮鎺斺偓姘煎墰缁骞嬮敂鐣屽幘婵犳鍠楅崝鏇㈠焵椤掍緡娈旈柍缁樻婵偓闁靛牆妫涢崢鍗炩攽閳藉棗鐏ｉ柛妯犲洤鍑犻柟杈鹃檮閻撴盯鎮楅敐搴濈盎闁哄棛鍠栭弻鐔割槹鎼粹寬銉╂煙妞嬪骸鈻堟鐐存崌楠炴帡寮埀顒勫磻瑜斿?,
        },
      ],
    },
  ],
  summary_rollup: [
    {
      title: "闂傚倸鍊烽懗鍫曘€佹繝鍥ф槬闁哄稁鍘介弲顏堟煟閻斿摜鐭屽褎顨呴～蹇涙偡闁妇鍔烽棅顐㈡处缁嬫垹绮绘繝姘厱闁归偊鍘肩徊缁樻叏?,
      fields: [
        {
          key: "rawChatSourceMode",
          label: "闂傚倸鍊风粈渚€骞夐敓鐘偓锕傚炊椤掆偓缁愭鏌熼悧鍫熺凡闁告垹濞€閺屾盯骞囬棃娑欑亪缂備胶瀚忛崶銊у帾婵犮垼鍩栫粙鎴︺€呴鍕厽闁哄稁鍓熼崫鍝勄庨崶褝韬い銏＄☉椤啰鎷犻煫顓烆棜闁诲氦顫夊ú鏍洪妸鈹库偓?,
          type: "enum",
          options: [
            { value: "ignore_bme_hide", label: "闂傚倸鍊搁…顒勫磻閸曨個娲Ω閳轰胶鏌у銈嗗姧缁犳垵效?BME 闂傚倸鍊搁崐鎼佸磹閹间礁绠犻煫鍥ㄧ☉缁€澶嬩繆椤栨瑧绉挎繛鎴烆焽閺嗗棝鏌涢弴銊ヤ簽妞わ富鍣ｅ娲礃閸欏鍎撻梺绋匡攻閹倽鐭炬繛鎾村焹閸嬫捇鏌＄仦璇插闁宠棄顦灒闁绘挸瀵掗弳顏嗙磽閸屾瑧璐伴柛鐘崇墱閳ь剚绋堥弲婵堝垝濮樿泛纭€闁绘劏鏅滈弬鈧梻浣稿閸嬪棝宕伴幇鐗堝仼妞ゆ帒瀚埛鎴犵磼鐎ｎ厽纭剁紒鐘冲▕閺屾稑螣閻樺弶绁╅柡浣革躬閺岀喖鏌囬敃鈧獮妤€鈹戦姘煎殶闁逞屽墮缁犲秹宕曟潏鈺傚床闁圭儤姊婚惌? },
          ],
          defaultValue: "ignore_bme_hide",
          help: "闂傚倸鍊烽懗鍫曘€佹繝鍥ф槬闁哄稁鍘介弲顏堟煟閻斿摜鐭屽褎顨呰灋闁告劦鍠氬畵渚€鏌嶈閸撶喖寮婚妶鍡樺弿闁归偊鍏橀崑鎾澄旈埀顒勫煝閺冨牆顫呴柣娆屽亾婵炲皷鍓濈换娑㈠箣閻愬灚鍣介梺缁樺笧閸嬫捇濡甸崟顖氱闁告挷绀佺粭锛勭磽娴ｅ壊鍎忔い锔诲灦椤㈡ɑ绺界粙璺ㄥ€為梺闈浤涢崘銊︾槪闂傚倸鍊峰ù鍥綖婢跺顩插ù鐘差儏绾惧潡鏌熺紒銏犳珮闁轰礁顑呴湁闁稿繐鍚嬬紞鎴︽煟椤撶噥娈滈柡灞糕偓宕囨殼妞ゆ梻鍘ч弳鐐烘煛鐎ｎ喚鐣烘慨濠冩そ瀹曨偊宕熼鐔蜂壕缂佸锛曞ú顏勭厸闁稿本绮犲ú鎼佹⒑缂佹﹩娈旈柣妤€妫涘▎銏ゆ倷閻戞鍘撻梺鍛婄箓鐎氱兘宕曢幋鐑嗘闁绘劦浜滈悘鑼偓娈垮枛閻栧ジ宕洪敓鐘茬＜婵犲﹤瀚▍姘舵⒒娓氣偓濞艰崵绱炴笟鈧銊︽綇閳哄啰鐓旈梺鍛婎殘閸嬫劙寮ㄦ禒瀣厱妞ゆ劑鍊曢弸鎴︽煟閿濆骸澧撮柡灞稿墲瀵板嫭绻濋崟顐澑闂備胶鎳撻幉锟犲箖閸屾氨鏆﹂柨婵嗩槸楠炪垺绻涢幋鐐垫噮闁告ɑ鍔欓幃妤呯嵁閸喖濮庡┑鐐茬湴閸旀垵顕ｉ幖浣哥＜闁绘劕顕崢閬嶆椤愩垺澶勬繛鍙夌墱閺侇噣鎳滈悙閫涚盎闂佸搫鍟犻崑鎾绘煕閺冣偓閻楃娀鐛箛娑樺窛妞ゆ挆鍐╁€梻浣告啞閸斞呭緤閼恒儳顩?,
        },
      ],
    },
  ],
};

const TASK_PROFILE_REGEX_STAGES = [
  {
    key: "input",
    label: "闂傚倷绀侀幖顐λ囬鐐村亱濠电姴娲ょ粻浼存煙闂傚顦﹂柣顓燁殜閺屾盯鍩勯崘顏佹缂備胶濮甸崹鍧楀箖瑜版帒鐐婃い蹇撳濮ｃ垻绱掗悙顒€鍔ゆい顓犲厴瀵?,
    desc: "闂傚倸鍊烽懗鍫曘€佹繝鍥ㄥ剹闁搞儺鍓欑粈鍐煏婵炑冨暙缁犳垿姊婚崒娆掑厡妞ゎ厼鐗忛幑銏ゅ醇閵夈儳顦梺纭呮彧缁犳垹澹曢崸妤佸€垫繛鎴烆伆閹寸姷绀婇柛銉墯閻撴瑩鏌熼鍡楀暞濮ｆ劙鎮楀▓鍨灍濠电偛锕ら～蹇旂節濮橆剛顦ㄥ銈嗘尵閸嬬喖宕㈤銏╂富闁靛牆妫欓悡銉╂煟椤撶偛鈧灝顕ｉ銏╁悑闁告侗浜濋～宥呪攽閻愬弶顥為柛鏃€娲滃Σ鎰版晝閸屾稈鎷洪梺鍛婄☉椤剙鈻撻弴鐔虹闁告瑥顦遍惌宀勬煃瑜滈崜姘跺礄瑜版帒鍌ㄥΔ锝呭暙缁犵喎霉閸忓吋缍戞鐐灪娣囧﹪濡堕崒姘闂備礁鎼幊蹇涘箖閸岀偛钃熼柨婵嗩槸鎯熼梺闈涱槶閸庣儤瀵奸埀顒傜磽閸屾瑧璐伴柛鐘崇墱閹广垹螣閾忚娈惧┑顔筋焾濞夋盯鐛姀锛勭闁瑰鍋熼幉鍧楁煛鐎ｎ亝顥滈柍瑙勫灴閹瑩鎳犻鈧。娲⒑閸涘﹤鐒归柛瀣尵缁辨挻鎷呮禒瀣懙婵犮垻鎳撳Λ婵嬬嵁閹达箑绀嬫い鏍ㄧ☉娴滄粓姊虹粙璺ㄧ闁冲嘲鐗撳畷銉╁磼閻愬鍘介柟鑹版彧缁查箖宕甸埀顒勬⒑閸濄儱鏋傞柛鏃€鍨垮畷娲焵?,
  },
  {
    key: "input.userMessage",
    label: "闂傚倷绀侀幖顐λ囬鐐村亱濠电姴娲ょ粻浼存煙闂傚顦﹂柣? 闂傚倸鍊烽悞锕€顪冮崹顕呯劷闁秆勵殔缁€澶屸偓骞垮劚椤︻垶寮伴妷锔剧闁瑰鍊戝顑╋綁宕奸妷锔惧幈濡炪倖鍔戦崐鏇㈠几瀹ュ洨纾?,
    desc: "濠电姷鏁告慨浼村垂閻撳簶鏋栨繛鎴炲焹閸嬫挸顫濋悡搴㈢彎濡ょ姷鍋涢崯顖滄崲濠靛宸濇い鎰ㄥ墲閻繘姊绘担绛嬫綈闁稿孩濞婂畷顖炲锤濡?userMessage闂?,
  },
  {
    key: "input.recentMessages",
    label: "闂傚倷绀侀幖顐λ囬鐐村亱濠电姴娲ょ粻浼存煙闂傚顦﹂柣? 闂傚倸鍊风粈渚€骞栭锔藉亱闁告劦鍠栫壕濠氭煙閹规劦鍤欑紒鐙欏洦鐓冮柛婵嗗閳ь剚鎮傞幃姗€鏁愰崶鈺冿紲濠德板€愰崑鎾绘煕婵犲倹璐＄紒顔界懄瀵板嫮浠︾粙澶稿闂佹寧绻傛鍛婄濠靛鐓?,
    desc: "濠电姷鏁告慨浼村垂閻撳簶鏋栨繛鎴炲焹閸嬫挸顫濋悡搴㈢彎濡?recentMessages闂傚倸鍊风欢姘焽瑜嶈灋闁哄啫鐗嗙粻鎺楁煟閻樺灚鐝畉Messages闂傚倸鍊风欢姘焽瑜嶈灋闁哄啠鍋撻摶鐐存叏濠靛嫬鈧ogueText闂?,
  },
  {
    key: "input.candidateText",
    label: "闂傚倷绀侀幖顐λ囬鐐村亱濠电姴娲ょ粻浼存煙闂傚顦﹂柣? 闂傚倸鍊烽懗鍫曗€﹂崼銉︽櫇闁靛鏅滈崑锟犳煃閸濆嫭鍣归柣鎺戠仛閵囧嫰骞掗崱妞惧婵＄偑鍊х€靛矂宕板鍗炲灊妞ゆ挾鍋熼弳鍡涙煕閺囥劌浜炴い鏃€鍨甸埞鎴﹀煡閸℃浠銈嗗灦閻熴儳鍙?,
    desc: "濠电姷鏁告慨浼村垂閻撳簶鏋栨繛鎴炲焹閸嬫挸顫濋悡搴㈢彎濡?candidateText闂傚倸鍊风欢姘焽瑜嶈灋闁哄啫鐗嗙粻鎺楁煟閻欌偓濞插潐idateNodes闂傚倸鍊风欢姘焽瑜嶈灋闁哄啫鐗婇崵鎰版煟閹烘繃鎲縠Content 闂傚倸鍊风粈渚€骞夐敍鍕灊鐎光偓閸曨剙娈ｅ銈嗙墱閸嬫稓绮婚弽顓熺厱闁靛鍨哄▍鍥倶韫囨洘鏆╃紒杈ㄦ尰閹峰懘鎳栭埄鍐ㄧ伌鐎规洑鍗冲畷銊р偓娑櫭禒顓㈡⒑閸濆嫭澶勭€光偓缁嬫鐎堕柣鎴ｅГ閻?,
  },
  {
    key: "input.finalPrompt",
    label: "闂傚倷绀侀幖顐λ囬鐐村亱濠电姴娲ょ粻浼存煙闂傚顦﹂柣? 闂傚倸鍊风粈渚€骞夐敓鐘冲仭闁挎洖鍊搁崹鍌炴煕瑜庨〃鍛存倿閸偁浜滈柟杈剧稻绾埖銇勯敂鑲╃暠妞ゎ叀鍎婚ˇ鏉戔攽閻愨晛浜鹃柣搴㈩問閸犳岸寮繝姘槬闁逞屽墯閵囧嫰骞掗幋婵冨亾閼姐倕顥氬┑鍌氭啞閻撴洘銇勯幇鈺佲偓鏇㈠几閺冨牆鐤柟闂寸劍閳?,
    desc: "闂傚倸鍊风欢姘焽閼姐倖瀚婚柣鏃傚帶缁€澶屸偓骞垮劚閹冲矂鍩€椤掍礁娴€规洘绮嶉幏鍛存惞閻у摜搴?messages 闂傚倸鍊烽懗鍫曗€﹂崼銏″床闁割偁鍎辩粈澶愭煙鏉堝墽鐣辩痪鎯ф健閹妫冨☉娆愬枑缂佺偓鍎抽妶鎼佸蓟濞戙垹鍗抽柕濞垮劜閻濐喖鈹戦埥鍡椾簻闁硅櫕锕㈤獮鍐ㄎ旈崨顔间画闂佺粯顨呴悧濠囧箯闁秵鈷戦柟鑲╁仜婵＄晫鈧厜鍋撻柛娑橈梗缁诲棝鎮楀☉娅虫垶鍒婇幘顔界厽闁瑰浼濋鍫熷€跨紒瀣氨閺€鑺ャ亜閺冨倹娅曠紒鐘冲缁辨帡骞撻幒鍡椾壕闁绘梻绻濆Ч妤呮⒑缁嬭法鐏遍柛瀣仱閹偟鎷犵憗浣哥秺閺佹劙宕奸悤浣峰摋闂?LLM 闂傚倸鍊风粈渚€骞夐敓鐘茬闁告縿鍎抽惌鎾绘煕閹捐尙顦﹂柛銊︾箞閺岋綁骞嬮悜鍡欏姺闂佸磭绮Λ鍐蓟瀹ュ牜妾ㄩ梺鍛婃尰閻熲晜淇婇幘顔肩婵°倐鍋撶€瑰憡绻冮妵鍕籍閸屾繃顎楀┑鈥虫▕閸ㄨ泛顫?,
  },
  {
    key: "output",
    label: "闂傚倷绀侀幖顐λ囬鐐村亱濠电姴娲ょ粻浼存煙闂傚顦﹂柛姘愁潐閵囧嫰骞橀崡鐐典患缂備胶濮甸崹鍧楀箖瑜版帒鐐婃い蹇撳濮ｃ垻绱掗悙顒€鍔ゆい顓犲厴瀵?,
    desc: "闂傚倸鍊烽懗鍫曘€佹繝鍥ㄥ剹闁搞儺鍓欑粈鍐煏婵炑冨暙缁犳垿姊婚崒娆掑厡妞ゎ厼鐗忛幑銏ゅ醇閵夈儳顦梺纭呮彧缁犳垹澹曢崸妤佸€垫繛鎴烆伆閹寸姷绀婇柛銉墯閻撴瑩鏌熼鍡楀暞濮ｆ劕鈹戦鍡欏埌妞わ箓娼ч～蹇旂節濮橆剛顦ㄥ銈嗘尵閸嬬喖宕㈤銏╂富闁靛牆妫欓悡銉╂煟椤撶偛鈧灝顕ｉ銏╁悑闁告侗浜濋～宥呪攽閻愬弶顥為柛鏃€娲滃Σ鎰版晝閸屾稈鎷洪梺鍛婄☉椤剙鈻撻弴鐔虹闁告瑥顦遍惌宀勬煃瑜滈崜姘跺礄瑜版帒鍌ㄥΔ锝呭暙缁犵喎霉閸忓吋缍戞鐐灪娣囧﹪濡堕崒姘闂備礁鎼幊蹇涘箖閸岀偛钃熼柨婵嗩槸鎯熼梺闈涱槶閸庣儤瀵奸埀顒傜磽閸屾瑧璐伴柛鐘崇墱閹广垹螣閾忚娈惧┑顔筋焾濞夋盯鐛姀锛勭闁瑰鍋熼幉鍧楁煛鐎ｎ亝顥滈柍瑙勫灴閹瑩鎳犻鈧。娲⒑閸涘﹤鐒归柛瀣尵缁辨挻鎷呮禒瀣懙婵犮垻鎳撳Λ婵嬬嵁閹达箑绀嬫い鏍ㄧ☉娴滄粓姊虹粙璺ㄧ闁冲嘲鐗撳畷銉╁磼閻愬鍘介柟鑹版彧缁查箖宕甸埀顒勬⒑閸濄儱鏋傞柛鏃€鍨垮畷娲焵?,
  },
  {
    key: "output.rawResponse",
    label: "闂傚倷绀侀幖顐λ囬鐐村亱濠电姴娲ょ粻浼存煙闂傚顦﹂柛? 闂傚倸鍊风粈渚€骞夐敓鐘偓锕傚炊椤掆偓缁愭骞栭幖顓犲帨缂傚秵鐗犻弻鐔兼偋閸喓鍑℃繛纾嬪亹婵兘鍩€椤掆偓缁犲秹宕曢柆宥呯疇闁归偊鍠掗崑?,
    desc: "LLM 闂傚倸鍊风粈渚€骞夐敓鐘偓锕傚炊椤掆偓缁愭骞栭幖顓犲帨缂傚秵鐗犻弻鐔兼偋閸喓鍑″┑鈽嗗亝閿曘垽寮诲☉銏犖ㄩ柨婵嗘噹椤姊洪崷顓炲幋濞存粌鐖煎璇测槈閵忕姷顔婇梺鍝勫€归娆撳汲椤撶喓绡€闁冲皝鍋撻柛鏇ㄥ幘閻撳鎮楃憴鍕８闁稿孩鐓￠獮鍡涘籍閸繄浼嬮梺鍛婂姈瑜板啰妲愰浣虹瘈闁汇垽娼ф禒锕傛煙閸涘﹥鍊愭鐐诧龚缁犳盯寮撮悩鐢靛姸闂備胶顭堥張顒傜矙閹捐鐓濋柡鍐ㄧ墛閻撳啰鎲稿鍫濈婵炲棙鎸搁悡婵嬪箹濞ｎ剙鐏╃紒鐘靛█濮?,
  },
  {
    key: "output.beforeParse",
    label: "闂傚倷绀侀幖顐λ囬鐐村亱濠电姴娲ょ粻浼存煙闂傚顦﹂柛? 闂傚倷娴囧畷鐢稿窗閹扮増鍋￠弶鍫氭櫅缁躲倕螖閿濆懎鏆為柛濠囨涧闇夐柣妯烘▕閸庡繒绱掗埀?,
    desc: "闂?JSON 闂傚倸鍊风粈浣革耿鏉堚晛鍨濇い鏍仜缁€澶愭煛閸ゅ爼顣﹀Ч?闂傚倷娴囧畷鐢稿窗閹扮増鍋￠弶鍫氭櫅缁躲倕螖閿濆懎鏆為柛濠囨涧闇夐柣妯烘▕閸庡繒绱掗埀顒勫醇閳垛晛浜炬鐐茬仢閸旀岸鏌熼崘鏌ュ弰鐎殿喗褰冮埢搴ㄥ箛椤旂虎鍟庨梻浣筋潐瀹曟ê鈻嶉弴銏犻棷闁惧繐婀辩壕濂告煃瑜滈崜鐔风暦閹烘垟妲堟慨姗堢稻閻忓啴姊绘笟鈧埀顒傚仜閼活垱鏅堕鈧弻宥囨嫚閹绘帩鍔夊Δ鐘靛仜閿曨亪寮?,
  },
];

let panelEl = null;
let overlayEl = null;
let graphRenderer = null;
let mobileGraphRenderer = null;
let currentTabId = "dashboard";
let currentConfigSectionId = "toggles";
let currentTaskProfileTaskType = "extract";
let currentTaskProfileTabId = "generation";
let currentTaskProfileBlockId = "";
let currentTaskProfileDragBlockId = "";
let currentTaskProfileRuleId = "";
let currentTaskProfileDragRuleId = "";
let currentTaskProfileDragRuleIsGlobal = false;
let showGlobalRegexPanel = false;
let currentGlobalRegexRuleId = "";
let currentCognitionOwnerKey = "";
let currentGraphView = "graph";
let fetchedMemoryLLMModels = [];
let fetchedBackendEmbeddingModels = [];
let fetchedDirectEmbeddingModels = [];
let viewportSyncBound = false;
let popupRuntimePromise = null;

// 闂?index.js 婵犵數濮烽弫鎼佸磻濞戔懞鍥敇閵忕姷顦悗鍏夊亾闁告洦鍋嗛悡鎴︽⒑缁洖澧茬紒瀣浮瀹曟洖顓兼径瀣幈闂佸搫娲㈤崝灞剧閻愮數纾奸悘鐐跺Г閸嬨儵鏌?
let _getGraph = null;
let _getSettings = null;
let _getLastExtract = null;
let _getLastBatchStatus = null;
let _getLastRecall = null;
let _getRuntimeStatus = null;
let _getLastExtractionStatus = null;
let _getLastVectorStatus = null;
let _getLastRecallStatus = null;
let _getLastInjection = null;
let _getRuntimeDebugSnapshot = null;
let _getGraphPersistenceState = null;
let _updateSettings = null;
let _actionHandlers = {};

async function loadLocalTemplate(templateName) {
  const templateUrl = new URL(`./${templateName}.html`, import.meta.url);
  const response = await fetch(templateUrl.href, {
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(
      `Template request failed: ${templateUrl.pathname} (${response.status} ${response.statusText})`,
    );
  }
  const html = await response.text();
  if (typeof html !== "string" || html.trim().length === 0) {
    throw new Error(`Template returned empty content: ${templateUrl.pathname}`);
  }
  return html;
}

async function getPopupRuntime() {
  if (!popupRuntimePromise) {
    popupRuntimePromise = import("../../../../popup.js");
  }
  return await popupRuntimePromise;
}

function _ensureCloudBackupManagerStyles() {
  if (document.getElementById("bme-cloud-backup-manager-styles")) return;
  const style = document.createElement("style");
  style.id = "bme-cloud-backup-manager-styles";
  style.textContent = `
    .bme-cloud-backup-modal {
      width: min(920px, 88vw);
      max-width: 100%;
      color: var(--SmartThemeBodyColor, #f2efe8);
    }
    .bme-cloud-backup-modal__header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 12px;
      margin-bottom: 14px;
    }
    .bme-cloud-backup-modal__title {
      font-size: 22px;
      font-weight: 700;
      margin: 0;
    }
    .bme-cloud-backup-modal__subtitle {
      opacity: 0.78;
      line-height: 1.5;
      margin-top: 6px;
    }
    .bme-cloud-backup-modal__tools {
      display: inline-flex;
      gap: 8px;
      flex-wrap: wrap;
      justify-content: flex-end;
    }
    .bme-cloud-backup-modal__btn {
      border: 1px solid var(--SmartThemeBorderColor, rgba(255,255,255,0.18));
      background: var(--SmartThemeBlurTintColor, rgba(255,255,255,0.06));
      color: inherit;
      border-radius: 10px;
      padding: 8px 12px;
      cursor: pointer;
    }
    .bme-cloud-backup-modal__btn:hover:not(:disabled) {
      border-color: rgba(255, 181, 71, 0.65);
    }
    .bme-cloud-backup-modal__btn:disabled {
      opacity: 0.55;
      cursor: wait;
    }
    .bme-cloud-backup-modal__list {
      display: grid;
      gap: 12px;
      max-height: 62vh;
      overflow: auto;
      padding-right: 4px;
    }
    .bme-cloud-backup-modal__empty,
    .bme-cloud-backup-modal__loading {
      border: 1px dashed var(--SmartThemeBorderColor, rgba(255,255,255,0.18));
      border-radius: 14px;
      padding: 18px;
      opacity: 0.85;
      text-align: center;
    }
    .bme-cloud-backup-card {
      border: 1px solid var(--SmartThemeBorderColor, rgba(255,255,255,0.18));
      border-radius: 14px;
      padding: 14px;
      background: rgba(255,255,255,0.03);
    }
    .bme-cloud-backup-card.is-current-chat {
      border-color: rgba(255, 181, 71, 0.78);
      box-shadow: 0 0 0 1px rgba(255, 181, 71, 0.22) inset;
    }
    .bme-cloud-backup-card__top {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: flex-start;
      margin-bottom: 8px;
    }
    .bme-cloud-backup-card__title {
      font-size: 16px;
      font-weight: 700;
      word-break: break-word;
    }
    .bme-cloud-backup-card__badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      border-radius: 999px;
      padding: 4px 10px;
      background: rgba(255, 181, 71, 0.15);
      color: #ffcf7a;
      font-size: 12px;
      white-space: nowrap;
    }
    .bme-cloud-backup-card__meta {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 8px 12px;
      margin-bottom: 10px;
      font-size: 13px;
      opacity: 0.88;
    }
    .bme-cloud-backup-card__filename {
      font-family: Consolas, Monaco, monospace;
      font-size: 12px;
      word-break: break-all;
      opacity: 0.72;
      margin-bottom: 12px;
    }
    .bme-cloud-backup-card__actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      flex-wrap: wrap;
    }
    .bme-cloud-backup-card__danger {
      border-color: rgba(255, 107, 107, 0.45);
      color: #ffd4d4;
    }
  `;
  document.head.appendChild(style);
}

function mountPanelHtml(html) {
  const markup = String(html || "").trim();
  if (!markup) {
    throw new Error("Panel template markup is empty");
  }

  if (document.body?.insertAdjacentHTML) {
    document.body.insertAdjacentHTML("beforeend", markup);
    return;
  }

  const template = document.createElement("template");
  template.innerHTML = markup;
  const fragment = template.content.cloneNode(true);
  document.documentElement?.appendChild(fragment);
}

function ensureNodeMountedAtRoot(node, { beforeBody = false } = {}) {
  if (!node) return;
  const root = document.documentElement;
  const body = document.body;
  if (!root) return;

  if (beforeBody && body?.parentElement === root) {
    if (node.parentElement === root && node.nextElementSibling === body) {
      return;
    }
    root.insertBefore(node, body);
    return;
  }

  if (node.parentElement === root) {
    return;
  }

  root.appendChild(node);
}

function ensureOverlayMountedAtRoot() {
  ensureNodeMountedAtRoot(overlayEl, { beforeBody: true });
}

function ensureFabMountedAtRoot() {
  ensureNodeMountedAtRoot(_fabEl);
}

function getViewportMetrics() {
  const viewport = window.visualViewport;
  return {
    width: Math.max(
      1,
      Math.round(viewport?.width || window.innerWidth || 0),
    ),
    height: Math.max(
      1,
      Math.round(viewport?.height || window.innerHeight || 0),
    ),
  };
}

function syncViewportCssVars() {
  const rootStyle = document.documentElement?.style;
  if (!rootStyle) return;

  const { width, height } = getViewportMetrics();

  rootStyle.setProperty("--bme-viewport-width", `${width}px`);
  rootStyle.setProperty("--bme-viewport-height", `${height}px`);
}

function getFabFallbackSize() {
  return _isMobile() ? 54 : 46;
}

function getFabSize(fab = _fabEl) {
  if (fab) {
    const rect = fab.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      return {
        width: rect.width,
        height: rect.height,
      };
    }
  }

  const fallback = getFabFallbackSize();
  return {
    width: fallback,
    height: fallback,
  };
}

function getDefaultFabPosition(fab = _fabEl) {
  const { width: viewportWidth, height: viewportHeight } = getViewportMetrics();
  const { width, height } = getFabSize(fab);
  const sideGap = _isMobile() ? 14 : 16;
  const bottomGap = _isMobile() ? 96 : 80;

  return {
    x: Math.max(sideGap, viewportWidth - width - sideGap),
    y: Math.max(sideGap, viewportHeight - height - bottomGap),
  };
}

function clampFabPosition(position = {}, fab = _fabEl) {
  const { width: viewportWidth, height: viewportHeight } = getViewportMetrics();
  const { width, height } = getFabSize(fab);
  const margin = _isMobile() ? 10 : 8;
  const maxX = Math.max(margin, viewportWidth - width - margin);
  const maxY = Math.max(margin, viewportHeight - height - margin);
  const x = Number.isFinite(position?.x) ? position.x : maxX;
  const y = Number.isFinite(position?.y) ? position.y : maxY;

  return {
    x: Math.min(Math.max(margin, Math.round(x)), Math.round(maxX)),
    y: Math.min(Math.max(margin, Math.round(y)), Math.round(maxY)),
  };
}

function applyFabPosition(position = {}, fab = _fabEl) {
  if (!fab) return;
  const clamped = clampFabPosition(position, fab);
  fab.style.left = `${clamped.x}px`;
  fab.style.top = `${clamped.y}px`;
  fab.style.right = "auto";
  fab.style.bottom = "auto";
}

function syncFabPosition() {
  if (!_fabEl) return;

  ensureFabMountedAtRoot();
  const mode = _fabEl.dataset.positionMode || "default";
  if (mode === "saved") {
    const currentX = Number.parseFloat(_fabEl.style.left);
    const currentY = Number.parseFloat(_fabEl.style.top);
    const fallback =
      _loadFabPosition() ||
      getDefaultFabPosition(_fabEl);
    const next = clampFabPosition(
      {
        x: Number.isFinite(currentX) ? currentX : fallback.x,
        y: Number.isFinite(currentY) ? currentY : fallback.y,
      },
      _fabEl,
    );
    applyFabPosition(next, _fabEl);
    _saveFabPosition(next.x, next.y);
    return;
  }

  applyFabPosition(getDefaultFabPosition(_fabEl), _fabEl);
}

function bindViewportSync() {
  if (viewportSyncBound) return;
  viewportSyncBound = true;

  const update = () => {
    syncViewportCssVars();
    syncFabPosition();
  };
  window.addEventListener("resize", update);
  window.addEventListener("orientationchange", update);
  window.visualViewport?.addEventListener("resize", update);
  window.visualViewport?.addEventListener("scroll", update);
}

/**
 * 闂傚倸鍊风粈渚€骞夐敍鍕殰婵°倕鍟畷鏌ユ煕瀹€鈧崕鎴犵礊閺嶎厽鐓欓柣妤€鐗婄欢鑼磼閳ь剙鐣濋崟顒傚幐閻庡箍鍎辨鎼佺嵁濡や椒绻嗘俊鐐靛帶婵倿鏌＄仦绋垮⒉鐎垫澘瀚换婵嬪磼濠婂嫷鍟囩紓鍌氬€峰ù鍥ㄣ仈閹间焦鍋￠柍鍝勬噹缁?index.js 闂傚倷娴囧畷鍨叏閹绢噮鏁勯柛娑欐綑閻ゎ喖霉閸忓吋缍戦柡瀣╃窔閺屾洟宕煎┑鍥舵￥闂佸磭绮Λ鍐蓟瀹ュ牜妾ㄩ梺鍛婃尰閻熲晠宕洪姀鈩冨劅闁靛鍎抽崣鈧梻浣告啞娓氭宕归幎鍓?
 */
export async function initPanel({
  getGraph,
  getSettings,
  getLastExtract,
  getLastBatchStatus,
  getLastRecall,
  getRuntimeStatus,
  getLastExtractionStatus,
  getLastVectorStatus,
  getLastRecallStatus,
  getLastInjection,
  getRuntimeDebugSnapshot,
  getGraphPersistenceState,
  updateSettings,
  actions,
}) {
  _getGraph = getGraph;
  _getSettings = getSettings;
  _getLastExtract = getLastExtract;
  _getLastBatchStatus = getLastBatchStatus;
  _getLastRecall = getLastRecall;
  _getRuntimeStatus = getRuntimeStatus;
  _getLastExtractionStatus = getLastExtractionStatus;
  _getLastVectorStatus = getLastVectorStatus;
  _getLastRecallStatus = getLastRecallStatus;
  _getLastInjection = getLastInjection;
  _getRuntimeDebugSnapshot = getRuntimeDebugSnapshot;
  _getGraphPersistenceState = getGraphPersistenceState;
  _updateSettings = updateSettings;
  _actionHandlers = actions || {};

  overlayEl = document.getElementById("st-bme-panel-overlay");
  panelEl = document.getElementById("st-bme-panel");

  if (!overlayEl || !panelEl) {
    const html = await loadLocalTemplate("panel");
    mountPanelHtml(html);
    overlayEl = document.getElementById("st-bme-panel-overlay");
    panelEl = document.getElementById("st-bme-panel");
    if (!overlayEl || !panelEl) {
      throw new Error(
        "Panel template rendered but required DOM nodes were not found",
      );
    }
  }

  ensureOverlayMountedAtRoot();
  bindViewportSync();
  syncViewportCssVars();

  _bindTabs();
  _bindClose();
  _bindNodeDetailPanel();
  _bindResizeHandle();
  _bindPanelResize();
  _bindGraphControls();
  _bindActions();
  _bindDashboardControls();
  _bindConfigControls();
  _bindPlannerLauncher();
  currentTabId =
    panelEl?.querySelector(".bme-tab-btn.active")?.dataset.tab || "dashboard";
  _applyWorkspaceMode();
  _syncConfigSectionState();
  _refreshRuntimeStatus();
  _initFloatingBall();
  _bindFabToggle();
}

// ==================== 闂傚倸鍊峰ù鍥敋閺嶎厼闂い鏇楀亾鐎规洘绮岄～婵囨綇閵娿儳褰撮梻浣虹帛閸旀宕曢妶澶婄；?====================

const FAB_STORAGE_KEY = "bme-fab-position";
const FAB_VISIBLE_KEY = "bme-fab-visible";
let _fabEl = null;

function _getFabVisible() {
  try {
    const val = localStorage.getItem(FAB_VISIBLE_KEY);
    return val === null ? true : val === "true";
  } catch { return true; }
}

function _setFabVisible(visible) {
  try { localStorage.setItem(FAB_VISIBLE_KEY, String(visible)); } catch {}
  if (_fabEl) {
    ensureFabMountedAtRoot();
    _fabEl.style.display = visible ? "flex" : "none";
    if (visible) {
      syncFabPosition();
    }
  }
  const btn = panelEl?.querySelector("#bme-fab-toggle-btn");
  if (btn) btn.setAttribute("data-active", String(visible));
}

function _bindFabToggle() {
  const btn = panelEl?.querySelector("#bme-fab-toggle-btn");
  if (!btn) return;
  btn.setAttribute("data-active", String(_getFabVisible()));
  btn.addEventListener("click", () => {
    const next = !_getFabVisible();
    _setFabVisible(next);
  });
}

function _initFloatingBall() {
  const existing = document.getElementById("bme-floating-ball");
  if (existing) {
    _fabEl = existing;
    ensureFabMountedAtRoot();
    syncFabPosition();
    return;
  }

  const fab = document.createElement("div");
  fab.id = "bme-floating-ball";
  fab.setAttribute("data-status", "idle");
  fab.innerHTML = `
    <i class="fa-solid fa-brain bme-fab-icon"></i>
    <span class="bme-fab-tooltip">BME 闂傚倷娴囧畷鍨叏閹惰姤鍊块柨鏇楀亾妞ゎ厼鐏濊灒闁稿繒鍘ф惔濠囨⒑缁嬭法鐏遍柛瀣洴閹瑦绻濋崶銊у幍闁荤喐鐟ョ€氼剚鎱ㄩ崼銉︾厽?/span>
  `;
  _fabEl = fab;
  ensureFabMountedAtRoot();

  // 闂傚倷绀佸﹢閬嶅储瑜旈幃娲Ω閵夘喗缍庢繝鐢靛У閼归箖寮告笟鈧弻鏇㈠醇濠垫劖笑闂佹椿鍘介〃鍡涘Φ閸曨垰鍐€闁靛ě鍜佸悑婵犵數鍋熼崢褔鎯岄崒鐐茶摕?
  if (!_getFabVisible()) fab.style.display = "none";

  // 闂傚倸鍊峰ù鍥敋閺嶎厼鍌ㄧ憸鐗堝笒閸ㄥ倻鎲搁悧鍫濆惞闁搞儺鍓欓惌妤€顭跨捄渚剰妞ゅ孩鎹囬幃妤呯嵁閸喖濮庡┑鐐茬湴閸旀垵顕?
  const saved = _loadFabPosition();
  if (saved) {
    fab.dataset.positionMode = "saved";
    applyFabPosition(saved, fab);
  } else {
    fab.dataset.positionMode = "default";
    syncFabPosition();
  }

  // 闂傚倸鍊风粈浣虹礊婵犲洤缁╅梺顒€绉甸崑瀣繆閵堝懎鏆婇柛?+ 闂傚倸鍊烽懗鍓佸垝椤栫偛绀夋俊銈呮噹缁犵娀鏌熼幑鎰靛殭闁告俺顫夐妵鍕即濡も偓娴滈箖姊洪崫鍕闁硅櫕锚椤曪綁骞忓畝鈧悿鈧梺鍝勬川閸嬬喖顢?
  let isDragging = false;
  let hasMoved = false;
  let startX = 0, startY = 0;
  let fabStartX = 0, fabStartY = 0;
  let clickTimer = null;

  const DRAG_THRESHOLD = 5;
  const DBLCLICK_DELAY = 280;

  function onPointerDown(e) {
    isDragging = true;
    hasMoved = false;
    startX = e.clientX;
    startY = e.clientY;
    const rect = fab.getBoundingClientRect();
    fabStartX = rect.left;
    fabStartY = rect.top;
    fab.setPointerCapture(e.pointerId);
    e.preventDefault();
  }

  function onPointerMove(e) {
    if (!isDragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (!hasMoved && Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
    hasMoved = true;

    applyFabPosition(
      {
        x: fabStartX + dx,
        y: fabStartY + dy,
      },
      fab,
    );
  }

  function onPointerUp(e) {
    if (!isDragging) return;
    isDragging = false;
    fab.releasePointerCapture(e.pointerId);

    if (hasMoved) {
      // 闂傚倸鍊风粈浣虹礊婵犲洤缁╅梺顒€绉甸崑瀣繆閵堝懎鏆婇柛瀣尭椤繈鎼归銈冣偓濠勭磽娴ｄ粙鍝洪悽顖ょ節閻涱喖螣鐏忔牕浜炬繛鎴烆仾椤忓牊鍎?闂?濠电姷鏁搁崕鎴犲緤閽樺娲晜閻愵剙搴婇梺绋跨灱閸嬬偤宕戦妶澶嬬厪濠电姴绻樺顔尖攽椤栨凹鍤熼柍褜鍓欑粻宥夊磿閸楃伝娲Ω閳轰礁鍤?
      fab.dataset.positionMode = "saved";
      _saveFabPosition(
        Number.parseInt(fab.style.left, 10),
        Number.parseInt(fab.style.top, 10),
      );
      return;
    }

    // 闂傚倸鍊搁崐鎼佸磹閹间焦鍋嬮煫鍥ㄧ☉绾惧鏌ｉ幇顕呮毌闁稿鎸搁～婵嬵敆婢跺﹤澹庢俊?闂?濠电姷鏁告慨浼村垂閻撳簶鏋栨繛鎴炲焹閸嬫挸顫濋悡搴㈢彎濡ょ姷鍋涢崯顖滄崲濠靛鐐婄憸蹇涖€侀崨瀛樷拺闁告繂瀚婵嬫煕鐎ｎ偆鈽夌悮?闂傚倸鍊风粈渚€骞夐敓鐘冲仭闁靛鏅滈崵鎰亜閺嶎偄浠滈柛?
    if (clickTimer) {
      // 缂傚倸鍊搁崐鐑芥倿閿曞倶鈧啳绠涘☉妯碱槯濠电偞鍨舵穱鐑樻叏閹惰姤鐓冮弶鐐村椤斿鏌＄€ｎ亪鍙勯柡灞诲妼閳藉螣娓氼垯鎮ｅ┑鐐差嚟婵參宕归崼鏇炶摕?闂?闂傚倸鍊风粈渚€骞夐敓鐘冲仭闁靛鏅滈崵鎰亜閺嶎偄浠滈柛?闂?闂?Roll
      clearTimeout(clickTimer);
      clickTimer = null;
      _onFabDoubleClick();
    } else {
      // 缂傚倸鍊搁崐鐑芥倿閿曞倶鈧啳绠涘☉妯碱槯濠电偞鍨跺銊╁础濮樿埖鐓涘璺侯儏閻忓秹鏌＄€ｎ亪鍙勯柡灞诲妼閳藉螣娓氼垯鎮ｅ┑鐐差嚟婵參宕归崼鏇炶摕?闂?缂傚倸鍊搁崐鐑芥倿閿斿墽鐭欓柟娆¤娲、娑橆煥閸曢潧浠洪梻浣虹帛濮婂宕㈣閹苯螖閸涱喖鈧爼鏌ｉ幇顖氱厫妞ゃ儱顦伴幈?
      clickTimer = setTimeout(() => {
        clickTimer = null;
        _onFabSingleClick();
      }, DBLCLICK_DELAY);
    }
  }

  fab.addEventListener("pointerdown", onPointerDown);
  document.addEventListener("pointermove", onPointerMove);
  document.addEventListener("pointerup", onPointerUp);
}

function _onFabSingleClick() {
  openPanel();
}

async function _onFabDoubleClick() {
  if (!_actionHandlers.reroll) return;

  try {
    _fabEl?.setAttribute("data-status", "running");
    await _actionHandlers.reroll({});
    _fabEl?.setAttribute("data-status", "success");
    _refreshDashboard();
    _refreshGraph();
    setTimeout(() => {
      const status = _getRuntimeStatus?.() || {};
      _fabEl?.setAttribute("data-status", status.status || "idle");
    }, 3000);
  } catch (err) {
    console.error("[ST-BME] FAB reroll failed:", err);
    _fabEl?.setAttribute("data-status", "error");
  }
}

function _loadFabPosition() {
  try {
    const raw = localStorage.getItem(FAB_STORAGE_KEY);
    if (!raw) return null;
    const pos = JSON.parse(raw);
    if (Number.isFinite(pos.x) && Number.isFinite(pos.y)) return pos;
  } catch {}
  return null;
}

function _saveFabPosition(x, y) {
  try {
    localStorage.setItem(FAB_STORAGE_KEY, JSON.stringify({ x, y }));
  } catch {}
}

export function updateFloatingBallStatus(status = "idle", tooltipText = "") {
  if (!_fabEl) return;
  _fabEl.setAttribute("data-status", status);
  if (tooltipText) {
    const tip = _fabEl.querySelector(".bme-fab-tooltip");
    if (tip) tip.textContent = tooltipText;
  }
}

/**
 * 闂傚倸鍊烽懗鍫曞箠閹剧粯鍊舵慨妯挎硾缁犱即鏌涘┑鍕姕妞ゎ偅娲熼弻鐔告綇妤ｅ啯顎嶅銈冨劚閻楁捇寮婚弴锛勭杸濠电姴鍊搁埛澶岀磽?
 */
export function openPanel() {
  if (!overlayEl) return;
  ensureOverlayMountedAtRoot();
  syncViewportCssVars();
  _actionHandlers.syncGraphLoad?.();
  overlayEl.classList.add("active");

  _restorePanelSize();

  const isMobile = _isMobile();
  const settings = _getSettings?.() || {};
  const themeName = settings.panelTheme || "crimson";

  const graphOpts = {
    theme: themeName,
    userPovAliases: _hostUserPovAliasHintsForGraph(),
  };
  const canvas = document.getElementById("bme-graph-canvas");
  if (canvas && !graphRenderer && !isMobile) {
    graphRenderer = new GraphRenderer(canvas, graphOpts);
    graphRenderer.onNodeSelect = (node) => _showNodeDetail(node);
  }

  const mobileCanvas = document.getElementById("bme-mobile-graph-canvas");
  if (mobileCanvas && !mobileGraphRenderer && isMobile) {
    mobileGraphRenderer = new GraphRenderer(mobileCanvas, graphOpts);
    mobileGraphRenderer.onNodeSelect = (node) => _showNodeDetail(node);
  }

  const activeTabId =
    panelEl?.querySelector(".bme-tab-btn.active")?.dataset.tab || currentTabId;
  _switchTab(activeTabId);
  _refreshRuntimeStatus();
  _refreshGraph();
  _buildLegend();
}

/**
 * 闂傚倸鍊烽懗鍫曗€﹂崼銏″床闁瑰鍋熺粻鎯р攽閻樿弓杩规繛鎴欏灩缁犵粯銇勯弮鍌滄憘婵☆偄鍟村娲濞戞氨鐣鹃梺鍛婃尰缁诲嫬鈻?
 */
export function closePanel() {
  if (!overlayEl) return;
  overlayEl.classList.remove("active");
}

/**
 * 闂傚倸鍊风粈渚€骞栭鈷氭椽濡舵径瀣槐闂侀潧艌閺呮盯鎷戦悢灏佹斀闁绘ɑ褰冮弳鐔兼煃缂佹ɑ鐓ラ柍瑙勫灴閹晠宕橀幓鎺撶槗闂?
 */
export function updatePanelTheme(themeName) {
  graphRenderer?.setTheme(themeName);
  mobileGraphRenderer?.setTheme(themeName);
  _buildLegend();
  _highlightThemeChoice(themeName);
}

export function refreshLiveState() {
  if (!overlayEl?.classList.contains("active")) return;
  _refreshRuntimeStatus();

  switch (currentTabId) {
    case "dashboard":
      _refreshDashboard();
      break;
    case "memory":
      _refreshMemoryBrowser();
      break;
    case "injection":
      void _refreshInjectionPreview();
      break;
    default:
      break;
  }

  if (
    currentTabId === "config" &&
    currentConfigSectionId === "prompts" &&
    currentTaskProfileTabId === "debug"
  ) {
    _refreshTaskProfileWorkspace();
  }
  if (currentTabId === "config" && currentConfigSectionId === "trace") {
    _refreshMessageTraceWorkspace();
  }

  _refreshGraph();
}

// ==================== Tab 闂傚倸鍊风粈渚€骞夐敍鍕殰闁圭儤鍤氬ú顏呮櫇闁逞屽墴閹?====================

function _bindTabs() {
  panelEl?.querySelectorAll(".bme-tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tabId = btn.dataset.tab;
      _switchTab(tabId);
    });
  });
}

function _switchTab(tabId) {
  currentTabId = tabId || "dashboard";
  panelEl?.querySelectorAll(".bme-tab-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === currentTabId);
  });

  panelEl?.querySelectorAll(".bme-tab-pane").forEach((pane) => {
    pane.classList.toggle("active", pane.id === `bme-pane-${currentTabId}`);
  });

  // 闂?缂傚倸鍊搁崐椋庣矆娓氣偓钘濋柟鍓佺摂閺佸鎲告惔銊ョ疄闁靛ň鏅涢悡娑㈡煕閹板吀绨荤€规洏鍎遍—鍐Χ閸℃瑥顫х紒鐐緲缁夊墎鍒掔€ｎ喖閱囬柕澶涚畱娴?tab 闂傚倸鍊烽懗鍫曗€﹂崼銏″床闁割偁鍎辩粈澶屸偓鍏夊亾闁告洦鍓欓崜鐢告⒑缁洖澧查柣鐕傜畵瀹曨垰煤椤忓懐鍘遍梺鏂ユ櫅閸熶即骞婇崟顓犳／?
  const mainEl = panelEl?.querySelector(".bme-panel-main");
  if (mainEl) {
    mainEl.classList.toggle("mobile-visible", currentTabId === "graph");
  }

  _applyWorkspaceMode();

  switch (currentTabId) {
    case "dashboard":
      _refreshDashboard();
      break;
    case "memory":
      _refreshMemoryBrowser();
      break;
    case "injection":
      void _refreshInjectionPreview();
      break;
    case "config":
      _refreshConfigTab();
      break;
    default:
      break;
  }
}

function _getPlannerApi() {
  return globalThis?.stBmeEnaPlanner || null;
}

function _refreshPlannerLauncher() {
  const button = document.getElementById("bme-open-ena-planner");
  const hint = document.getElementById("bme-open-ena-planner-hint");
  if (!button || !hint) return;

  const plannerApi = _getPlannerApi();
  const ready = typeof plannerApi?.openSettings === "function";

  button.disabled = !ready;
  button.classList.toggle("is-runtime-disabled", !ready);
  hint.textContent = ready
    ? "闂備浇顕уù鐑藉箠閹捐绠熼梽鍥Φ閹版澘绀冮柍鍝勫€稿鍧楁⒑缂佹ê濮囬柣掳鍔嶉幈銊ヮ煥閸喓鍘搁梺绋挎湰閿氶柍褜鍓氶〃鍫㈠垝閸喎绶為柟閭﹀幘閸樺崬鈹戦悙鍙夘棡闁挎岸鏌ｈ箛濞惧亾閹颁胶鍞甸悷婊勭箘缁骞嬮敂缁樻櫔闂佹寧绻傞ˇ顖炴倿閸偁浜滈柟鐑樺灥椤忣亪鏌涚€ｎ偄鐏﹂柕鍥у楠炴帡骞嬪┑鍐ㄤ壕闁哄嫬绻堟禍鍦偓鍏夊亾闁告洦鍓涢崢?Ena Planner 闂傚倷娴囧畷鍨叏瀹曞洨鐭嗗ù锝堫潐濞呯姴霉閻樺樊鍎愰柛瀣典邯閺屾盯鍩勯崗锔界矋缁傚秴顭ㄩ崼鐔哄幗闂佸綊鍋婇崜娆戞暜閵娾晜鐓?
    : "闂傚倸鍊风粈渚€骞栭锔藉亱婵犲﹤瀚々鍙夌節闂堟稓鎳佸鑸靛姇瀹告繃銇勯幒鏂垮付婵犫偓闁秴鐒垫い鎺戯功缁夐潧霉濠婂嫮鐭掗柟?Ena Planner 婵犵數濮烽。钘壩ｉ崨鏉戝瀭妞ゅ繐鐗嗛悞鍨亜閹烘垵鏆為柣婵愪邯閺屾稓鈧絻鍔岄崝锕傛煛鐏炶濡奸柍钘夘槸铻ｉ柤娴嬫櫅婵増淇婇悙顏勨偓鏍洪敃鍌氱闁绘梻鍘ч拑鐔兼倶閻愮數鎽傞柛姘儔閺屾盯顢曢妶鍛亖闂?ST-BME 闂傚倸鍊风粈渚€骞夐敓鐘冲殞闁绘劦鍓﹀▓浠嬫煙闂傚顦﹂柣銈庡櫍閺屽秷顧侀柛鎾跺枛楠炲啳銇愰幒鎴犲€為梺闈涱煭婵″洭鏁嶅鈧?;
}

function _bindPlannerLauncher() {
  const button = document.getElementById("bme-open-ena-planner");
  if (!button || button.dataset.bmeBound === "true") {
    _refreshPlannerLauncher();
    return;
  }

  button.addEventListener("click", () => {
    const plannerApi = _getPlannerApi();
    if (typeof plannerApi?.openSettings === "function") {
      plannerApi.openSettings();
    }
    _refreshPlannerLauncher();
  });

  button.dataset.bmeBound = "true";
  _refreshPlannerLauncher();
}

function _applyWorkspaceMode() {
  if (!panelEl) return;
  const isConfig = currentTabId === "config";
  panelEl.classList.toggle("config-mode", isConfig);
}

// ==================== 闂傚倸鍊烽悞锕傚箖閸洖纾块柟缁樺笧閺嗭附淇婇娆掝劅婵炲皷鏅犻弻鏇熺箾瑜嶇€氼剟寮搁崒鐐粹拺缂侇垱娲栨晶鍙夈亜閵娿儲顥犵紒顔碱儔瀹曞ジ濡烽敂鎯у箞闂備礁婀遍崕銈夊垂閼搁潧绶為柛鏇ㄥ幐閸?====================

function _switchGraphView(view) {
  currentGraphView = view || "graph";
  panelEl?.querySelectorAll(".bme-graph-view-tab").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.graphView === currentGraphView);
  });

  const canvas = document.getElementById("bme-graph-canvas");
  const legend = document.getElementById("bme-graph-legend");
  const statusbar = panelEl?.querySelector(".bme-graph-statusbar");
  const nodeDetail = document.getElementById("bme-node-detail");
  const cogWorkspace = document.getElementById("bme-cognition-workspace");
  const summaryWorkspace = document.getElementById("bme-summary-workspace");
  const graphControls = panelEl?.querySelector(".bme-graph-controls");

  const isGraph = currentGraphView === "graph";
  const isCognition = currentGraphView === "cognition";
  const isSummary = currentGraphView === "summary";
  if (canvas) canvas.style.display = isGraph ? "" : "none";
  if (legend) legend.style.display = isGraph ? "" : "none";
  if (statusbar) statusbar.style.display = isGraph ? "" : "none";
  if (nodeDetail) nodeDetail.style.display = isGraph ? "" : "none";
  if (graphControls) graphControls.style.display = isGraph ? "" : "none";
  if (cogWorkspace) cogWorkspace.hidden = !isCognition;
  if (summaryWorkspace) summaryWorkspace.hidden = !isSummary;
  if (cogWorkspace) cogWorkspace.style.display = isCognition ? "" : "none";
  if (summaryWorkspace) summaryWorkspace.style.display = isSummary ? "" : "none";

  if (isCognition) _refreshCognitionWorkspace();
  if (isSummary) _refreshSummaryWorkspace();
}

function _ownerAvatarHsl(name) {
  let hash = 0;
  const str = String(name || "");
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 55%, 42%)`;
}

function _normalizeOwnerUiType(ownerType = "") {
  const normalized = String(ownerType || "").trim();
  if (normalized === "user") return "user";
  if (normalized === "character") return "character";
  return "";
}

function _inferOwnerTypeFromKey(ownerKey = "") {
  const normalizedOwnerKey = String(ownerKey || "").trim().toLowerCase();
  if (normalizedOwnerKey.startsWith("user:")) return "user";
  if (normalizedOwnerKey.startsWith("character:")) return "character";
  return "";
}

function _getOwnerTypeDisplayLabel(ownerType = "") {
  const normalizedType = _normalizeOwnerUiType(ownerType);
  if (normalizedType === "user") return "闂傚倸鍊烽悞锕€顪冮崹顕呯劷闁秆勵殔缁€澶屸偓骞垮劚椤︻垶寮?;
  if (normalizedType === "character") return "闂傚倷娴囧畷鐢稿窗閹扮増鍋￠柨鏃傚亾閺嗘粓鏌ｉ弬鎸庢喐闁?;
  return "Owner";
}

function _buildOwnerCollisionIndex(owners = []) {
  const collisionIndex = new Map();
  for (const owner of Array.isArray(owners) ? owners : []) {
    const baseName =
      String(owner?.ownerName || owner?.ownerKey || "闂傚倸鍊风粈渚€骞栭锔藉亱婵犲﹤瀚々鍙夌節婵犲倻澧曠紒鐘靛█閺屻劑鎮㈤崫鍕戙垽鎮峰▎娆忣洭闁逞屽墮缁犲秹宕曢柆宥嗗亱婵犲﹤鍠氶悞浠嬫煥閻斿搫校闁?).trim() ||
      "闂傚倸鍊风粈渚€骞栭锔藉亱婵犲﹤瀚々鍙夌節婵犲倻澧曠紒鐘靛█閺屻劑鎮㈤崫鍕戙垽鎮峰▎娆忣洭闁逞屽墮缁犲秹宕曢柆宥嗗亱婵犲﹤鍠氶悞浠嬫煥閻斿搫校闁?;
    const nameKey = baseName.toLocaleLowerCase("zh-Hans-CN");
    const ownerType = _normalizeOwnerUiType(owner?.ownerType) || "unknown";
    const entry = collisionIndex.get(nameKey) || {
      count: 0,
      typeCounts: new Map(),
    };
    entry.count += 1;
    entry.typeCounts.set(ownerType, (entry.typeCounts.get(ownerType) || 0) + 1);
    collisionIndex.set(nameKey, entry);
  }
  return collisionIndex;
}

function _shortOwnerNodeId(owner = {}) {
  const nodeId = String(owner?.nodeId || "").trim();
  if (!nodeId) return "";
  return nodeId.length > 6 ? nodeId.slice(0, 6) : nodeId;
}

function _getOwnerDisplayInfo(owner = {}, collisionIndex = null) {
  const baseName =
    String(owner?.ownerName || owner?.ownerKey || "闂傚倸鍊风粈渚€骞栭锔藉亱婵犲﹤瀚々鍙夌節婵犲倻澧曠紒鐘靛█閺屻劑鎮㈤崫鍕戙垽鎮峰▎娆忣洭闁逞屽墮缁犲秹宕曢柆宥嗗亱婵犲﹤鍠氶悞浠嬫煥閻斿搫校闁?).trim() ||
    "闂傚倸鍊风粈渚€骞栭锔藉亱婵犲﹤瀚々鍙夌節婵犲倻澧曠紒鐘靛█閺屻劑鎮㈤崫鍕戙垽鎮峰▎娆忣洭闁逞屽墮缁犲秹宕曢柆宥嗗亱婵犲﹤鍠氶悞浠嬫煥閻斿搫校闁?;
  const ownerKey = String(owner?.ownerKey || "").trim();
  const ownerType =
    _normalizeOwnerUiType(owner?.ownerType) || _inferOwnerTypeFromKey(ownerKey);
  const typeLabel = _getOwnerTypeDisplayLabel(ownerType);
  const collisionInfo =
    collisionIndex instanceof Map
      ? collisionIndex.get(baseName.toLocaleLowerCase("zh-Hans-CN")) || null
      : null;
  const typeCounts =
    collisionInfo?.typeCounts instanceof Map ? collisionInfo.typeCounts : new Map();
  const totalCount = Number(collisionInfo?.count || 0);
  const sameTypeCount = Number(typeCounts.get(ownerType || "unknown") || 0);
  const hasCrossTypeCollision = totalCount > 1 && typeCounts.size > 1;
  const shortNodeId = ownerType === "character" ? _shortOwnerNodeId(owner) : "";

  let title = baseName;
  if (hasCrossTypeCollision) {
    title = `${baseName}闂?{typeLabel}闂傚倸鍊烽悞锔锯偓绗涘懐鐭欓柟杈剧稻椤?
  } else if (sameTypeCount > 1) {
    title =
      ownerType === "character" && shortNodeId
        ? `${baseName}闂?{typeLabel} ${shortNodeId}闂傚倸鍊烽悞锔锯偓绗涘懐鐭欓柟杈剧稻椤?
        : `${baseName}闂?{typeLabel}闂傚倸鍊烽悞锔锯偓绗涘懐鐭欓柟杈剧稻椤?
  }

  const subtitleParts = [typeLabel];
  if (ownerType === "character" && shortNodeId) {
    subtitleParts.push(`#${shortNodeId}`);
  }

  return {
    title,
    typeLabel,
    subtitle: subtitleParts.join(" 闂?"),
    avatarText: baseName.charAt(0) || "?",
    avatarSeed: ownerKey || `${ownerType}:${baseName}`,
    tooltip: [title, ownerKey && ownerKey !== title ? ownerKey : ""]
      .filter(Boolean)
      .join(" 闂?"),
  };
}

// ==================== 闂傚倷娴囧畷鍨叏閹惰姤鈷旂€广儱顦壕瑙勪繆閵堝懏鍣洪柛瀣€块弻銊モ槈濡警浠鹃梺鍝ュТ濡繈寮诲☉銏犵労闁告劗鍋撻悾椋庣磽娴ｇ鈧悂鎮ц箛娑樼劦妞ゆ帒鍠氬鎰版煙椤旇偐鍩ｇ€规洘娲熼獮宥夘敊閸撗屾Ц闂備礁鎼崯顐︽偋閸℃瑧鐭?====================

function _refreshCognitionWorkspace() {
  const graph = _getGraph?.();
  const loadInfo = _getGraphPersistenceSnapshot();
  if (!graph) return;

  const canRender =
    Boolean(graph) &&
    (_canRenderGraphData(loadInfo) || loadInfo.loadState === "empty-confirmed");

  _renderCogStatusStrip(graph, loadInfo, canRender);
  _renderCogOwnerList(graph, canRender);
  _renderCogOwnerDetail(graph, loadInfo, canRender);
  _renderCogSpaceTools(graph, loadInfo, canRender);
  _renderCogMonitorMini();
}

function _renderCogStatusStrip(graph, loadInfo, canRender) {
  const el = document.getElementById("bme-cog-status-strip");
  if (!el) return;

  if (!canRender) {
    el.innerHTML = `<div class="bme-cog-status-card" style="grid-column:1/-1"><div class="bme-cog-status-card__value">${_escHtml(_getGraphLoadLabel(loadInfo.loadState))}</div></div>`;
    return;
  }

  const historyState = graph?.historyState || {};
  const regionState = graph?.regionState || {};
  const timelineState = graph?.timelineState || {};
  const { owners, activeOwnerKey, activeOwner, activeOwnerLabels } =
    _getCurrentCognitionOwnerSummary(graph);
  const collisionIndex = _buildOwnerCollisionIndex(owners);
  const activeRegion = String(
    historyState.activeRegion || historyState.lastExtractedRegion || regionState.manualActiveRegion || "",
  ).trim();
  const activeRegionLabel = activeRegion
    ? `${activeRegion}${historyState.activeRegionSource ? ` 闂?${historyState.activeRegionSource}` : ""}`
    : "闂?;
  const adjacentRegions = Array.isArray(regionState?.adjacencyMap?.[activeRegion]?.adjacent)
    ? regionState.adjacencyMap[activeRegion].adjacent
    : [];
  const activeStoryTimeLabel = String(
    historyState.activeStoryTimeLabel || "",
  ).trim();
  const activeStoryTimeMeta = activeStoryTimeLabel
    ? `${activeStoryTimeLabel}${historyState.activeStoryTimeSource ? ` 闂?${historyState.activeStoryTimeSource}` : ""}`
    : "闂?;
  const recentStorySegments = Array.isArray(timelineState?.recentSegmentIds)
    ? timelineState.recentSegmentIds
        .map((segmentId) =>
          timelineState.segments?.find((segment) => segment.id === segmentId)?.label || "",
        )
        .filter(Boolean)
        .slice(0, 3)
    : [];

  el.innerHTML = `
    <div class="bme-cog-status-card">
      <div class="bme-cog-status-card__label"><i class="fa-solid fa-user"></i> 闂備浇宕甸崰鎰垝鎼淬垺娅犳俊銈呮噹缁犱即鏌涘☉姗堟敾婵炲懐濞€閺岋絽螣濞嗘儳娈梺鍦嚀閻栧ジ寮婚敐澶婄闁绘劕妫欓崹鍧楀箖閻㈠壊鏁嶉柣鎰ˉ閹锋椽姊洪崷顓х劸閻庢稈鏅犻幆鍐箣閿旂晫鍘?/div>
      <div class="bme-cog-status-card__value">${_escHtml(
        activeOwnerLabels.length > 0
          ? activeOwnerLabels.join(" / ")
          : activeOwner
            ? _getOwnerDisplayInfo(activeOwner, collisionIndex).title
            : activeOwnerKey || "闂?,
      )}</div>
    </div>
    <div class="bme-cog-status-card">
      <div class="bme-cog-status-card__label"><i class="fa-solid fa-location-dot"></i> 闂備浇宕甸崰鎰垝鎼淬垺娅犳俊銈呮噹缁犱即鏌涘☉姗堟敾婵炲懐濞€閺岋絽螣濞嗘儳娈梺鍦嚀閻栧ジ寮婚埄鍐ㄧ窞濠电姴瀚搹搴ㄦ⒒?/div>
      <div class="bme-cog-status-card__value">${_escHtml(activeRegionLabel)}</div>
    </div>
    <div class="bme-cog-status-card">
      <div class="bme-cog-status-card__label"><i class="fa-solid fa-diagram-project"></i> 闂傚倸鍊搁崐椋庢閿熺姴鍌ㄩ柛鎾楀啫鐏婂銈嗙墬缁秹寮冲鍫熺厵缂備降鍨归弸娑㈡煙閻熸壆鍩ｉ柡灞稿墲瀵板嫭绻濋崟顏囨闂?/div>
      <div class="bme-cog-status-card__value">${_escHtml(adjacentRegions.length > 0 ? adjacentRegions.join(" / ") : "闂?)}</div>
    </div>
    <div class="bme-cog-status-card">
      <div class="bme-cog-status-card__label"><i class="fa-solid fa-users"></i> 闂傚倷娴囧畷鍨叏閹惰姤鈷旂€广儱顦壕瑙勪繆閵堝懏鍣洪柛瀣€块弻銊モ槈濡警浠鹃梺鍝ュТ濡繈寮婚悢鍏煎€绘俊顖濆吹椤︺儱顪冮妶鍐ㄥ姎缂佺粯锕㈠?/div>
      <div class="bme-cog-status-card__value">${owners.length}</div>
    </div>
    <div class="bme-cog-status-card">
      <div class="bme-cog-status-card__label"><i class="fa-solid fa-clock"></i> 闂備浇宕甸崰鎰垝鎼淬垺娅犳俊銈呮噹缁犱即鏌涘☉姗堟敾婵炲懐濞€閺岋絽螣濞嗘儳娈紓浣插亾闁割偁鍨洪崰鎰板箹濞ｎ剙濡肩痪鎯ф健閻擃偊宕堕妸褉妲堢紓渚囧亜缁夊綊寮诲☉銏╂晝闁挎繂妫涢ˇ銊╂⒑?/div>
      <div class="bme-cog-status-card__value">${_escHtml(activeStoryTimeMeta)}</div>
    </div>
    <div class="bme-cog-status-card">
      <div class="bme-cog-status-card__label"><i class="fa-solid fa-timeline"></i> 闂傚倸鍊风粈渚€骞栭锔藉亱闁告劦鍠栫壕濠氭煙閹规劦鍤欑紒鐙欏洦鐓冮柛婵嗗閳ь剚鎮傞幃姗€鏁傞幋鎺旂畾闂佺粯鍔栬ぐ鍐焵椤掆偓閻忔繈锝炶箛娑欏殥闁靛牆鍊告禍鐐箾閹寸偟鎳曞〒姘洴閺?/div>
      <div class="bme-cog-status-card__value">${_escHtml(recentStorySegments.length ? recentStorySegments.join(" / ") : "闂?)}</div>
    </div>
  `;
}

function _renderCogOwnerList(graph, canRender) {
  const el = document.getElementById("bme-cog-owner-list");
  if (!el) return;

  if (!canRender) {
    el.innerHTML = "";
    return;
  }

  const { owners, activeOwnerKey, activeOwnerKeys } =
    _getCurrentCognitionOwnerSummary(graph);
  const collisionIndex = _buildOwnerCollisionIndex(owners);

  if (!owners.length) {
    el.innerHTML = `<div class="bme-cog-monitor-empty">闂傚倸鍊风粈渚€骞栭鈶芥稑螖閸涱厾锛欓梺鑽ゅ枑鐎氬牆鈽夐姀鐘栄囨煕閵夛絽濡兼い搴㈢洴濮婃椽妫冨☉姘暫濠电偛鐪伴崝鎴濈暦閿濆鐒垫い鎺戝閻撶喖鏌ｉ弬鎸庢喐闁瑰啿瀚伴幃浠嬵敍濠婂啯鐎剧紓?/div>`;
    return;
  }

  el.innerHTML = owners
    .map((owner) => {
      const displayInfo = _getOwnerDisplayInfo(owner, collisionIndex);
      const bgColor = _ownerAvatarHsl(displayInfo.avatarSeed);
      const selected = owner.ownerKey === currentCognitionOwnerKey ? "is-selected" : "";
      const anchor =
        owner.ownerKey === activeOwnerKey ||
        activeOwnerKeys.includes(owner.ownerKey)
          ? "is-active-anchor"
          : "";
      return `
        <div class="bme-cog-owner-card ${selected} ${anchor}"
             data-owner-key="${_escHtml(String(owner.ownerKey || ""))}"
             role="button" tabindex="0"
             title="${_escHtml(displayInfo.tooltip)}">
          <div class="bme-cog-avatar" style="background:${bgColor}">${_escHtml(displayInfo.avatarText)}</div>
          <div class="bme-cog-owner-card__info">
            <div class="bme-cog-owner-card__name-row">
              <div class="bme-cog-owner-card__name">${_escHtml(displayInfo.title)}</div>
              <span class="bme-cog-owner-card__badge">${_escHtml(displayInfo.typeLabel)}</span>
            </div>
            <div class="bme-cog-owner-card__stats">闂備浇顕у锕傦綖婢舵劖鍋ら柡鍥╁С閻掑﹥绻涢崱妯诲鞍闁?${Number(owner.knownCount || 0)} 闂?闂傚倷娴囧畷鍨叏閺夋嚚褰掑磼閻愭彃鐎繛杈剧到閸犳岸寮?${Number(owner.mistakenCount || 0)} 闂?闂傚倸鍊搁崐鎼佸磹閹间礁绠犻煫鍥ㄧ☉缁€澶嬩繆椤栨瑧绉?${Number(owner.manualHiddenCount || 0)}</div>
          </div>
        </div>`;
    })
    .join("");
}

function _renderCogOwnerDetail(graph, loadInfo, canRender) {
  const el = document.getElementById("bme-cog-owner-detail");
  if (!el) return;

  if (!canRender) {
    el.innerHTML = "";
    return;
  }

  const { selectedOwner, activeOwnerKey, activeOwnerKeys } =
    _getCurrentCognitionOwnerSummary(graph);
  const collisionIndex = _buildOwnerCollisionIndex(
    _getCognitionOwnerCollection(graph),
  );

  if (!selectedOwner) {
    el.innerHTML = `<div class="bme-cog-monitor-empty">闂傚倸鍊搁崐椋庢閿熺姴纾婚柛鏇ㄥ瀬閸ヮ剙绠ユい鏃傛嚀娴滅偓鎱ㄥΟ绋垮姎濠碉紕鏅槐鎺斺偓锝庝憾濡插湱绱掔紒妯肩疄鐎规洘锕㈤崺锟犲礃閵娿儳顓奸梻鍌欐祰瀹曠敻宕伴幇鐗堝仭闁挎梻鍋撻弳婊堟煟閺傛寧鎲搁柣婵婃硾閳规垿鎮╅崣澶嬫倷闂佽棄鍟伴崰鏍蓟閺囩喓鐝舵い鏍ㄨ壘椤忣偊鏌ｉ敐鍕煓闁哄矉缍侀幃鈺呭矗婢跺被鍋掗梻鍌氬€哥€氼剛鈧碍婢橀悾鐑藉即閿涘嫮鏉稿┑鐐村灦閻燂箑鈻嶉弽顓熺厽闊洦娲栨禒锕傛煕鎼淬垹鈻曢柟顔矫灃闁告劦浜為敍婊冣攽閻愭潙鐏﹂柨鏇楁櫅鍗遍柛婵勫劤绾惧ジ鏌涢幘鑼槮闁哄绋掗〃銉╂倷鐎涙ê纾冲Δ鐘靛仜濞差參銆佸Δ鍛劦妞ゆ帒鍊哥欢銈夋煕椤垵鏅归柣鐔稿閺€锕傛煟濡搫绾ч柛锝嗘そ閺岋繝宕ㄩ钘夆偓鎰版煙椤旀娼愰柟宄版嚇濡啫鈽夐幒鎴滃濠德板€曢幊蹇涘磻閸岀偞鐓ラ柣鏂挎惈瀛濋梺鍝勵儎缁舵岸寮婚敐鍛傛棃鍩€椤掑嫭鍋嬮柛鈩冪懅閻牓鏌ㄩ弴鐐测偓褰掓偂?/div>`;
    return;
  }

  const ownerState = graph?.knowledgeState?.owners?.[selectedOwner.ownerKey] || {
    aliases: selectedOwner.aliases || [],
    visibilityScores: {},
    manualKnownNodeIds: [],
    manualHiddenNodeIds: [],
    mistakenNodeIds: [],
    knownNodeIds: [],
    updatedAt: 0,
  };
  const visibilityEntries = Object.entries(ownerState.visibilityScores || {})
    .map(([nodeId, score]) => ({ nodeId: String(nodeId || ""), score: Number(score || 0) }))
    .filter((e) => e.nodeId)
    .sort((a, b) => b.score - a.score);
  const strongVisibleNames = _collectNodeNames(
    graph,
    visibilityEntries.filter((e) => e.score >= 0.68).map((e) => e.nodeId),
    { limit: 6 },
  );
  const suppressedNames = _collectNodeNames(
    graph,
    [...(ownerState.manualHiddenNodeIds || []), ...(ownerState.mistakenNodeIds || [])],
    { limit: 6 },
  );
  const selectedNode = _getSelectedGraphNode(graph);
  const selectedNodeLabel = selectedNode ? getNodeDisplayName(selectedNode) : "";
  const selectedNodeState = selectedNode
    ? ownerState.manualKnownNodeIds?.includes(selectedNode.id)
      ? "known"
      : ownerState.manualHiddenNodeIds?.includes(selectedNode.id)
        ? "hidden"
        : ownerState.mistakenNodeIds?.includes(selectedNode.id)
          ? "mistaken"
          : "none"
    : "";
  const stateLabels = { known: "闂備浇顕х€涒晠顢欓弽顓炵獥闁哄稁鍘肩粻瑙勩亜閹板墎鐣遍柡鍕╁劜娣囧﹪濡堕崒姘婵＄偑鍊栭弻銊ф崲濮椻偓楠炲﹪鎮╁ú缁樻櫌闂佺鏈懝鍓х磼?, hidden: "闂備浇顕х€涒晠顢欓弽顓炵獥闁哄稁鍘肩粻瑙勩亜閹板墎鐣遍柡鍕╁劜娣囧﹪濡堕崨顔兼闂佹娊鏀卞ú鐔煎蓟閻斿吋鐒介柨鏇楀亾闁诲繆鍓濋妵?, mistaken: "闂傚倷娴囧畷鍨叏閺夋嚚褰掑磼閻愭彃鐎繛杈剧到閸犳岸寮?, none: "闂傚倸鍊风粈渚€骞栭锔藉亱婵犲﹤瀚々鏌ユ煥濠靛棭妲堕柍褜鍓欓幊姗€銆侀弴銏℃櫆闁芥ê顦竟? };
  const selectedNodeStateLabel = stateLabels[selectedNodeState] || "闂傚倸鍊风粈渚€骞栭锔藉亱婵犲﹤瀚々鍙夈亜韫囨挾澧曢柣鎺戠仛閵囧嫰骞掗崱妞惧婵＄偑鍊х€靛矂宕抽敐澶婄疇婵炲棙鎸哥粻锝夋煥閺冨洦顥夋繛鍫㈠枛濮婅櫣绮欓幐搴㈡嫳缂備緡鍠栭張顒傜矉?;
  const writeBlocked = _isGraphWriteBlocked(loadInfo);
  const suppressedCount = new Set([...(ownerState.manualHiddenNodeIds || []), ...(ownerState.mistakenNodeIds || [])]).size;
  const disabledAttr = !selectedNode || writeBlocked ? "disabled" : "";
  const displayInfo = _getOwnerDisplayInfo(selectedOwner, collisionIndex);

  const visChips = strongVisibleNames.length
    ? strongVisibleNames.map((n) => `<span class="bme-cog-chip is-visible">${_escHtml(n)}</span>`).join("")
    : '<span class="bme-cog-chip is-empty">闂傚倸鍊风粈渚€骞栭鈶芥稑螖閸涱厾锛欓梺鑽ゅ枑鐎?/span>';
  const supChips = suppressedNames.length
    ? suppressedNames.map((n) => `<span class="bme-cog-chip is-suppressed">${_escHtml(n)}</span>`).join("")
    : '<span class="bme-cog-chip is-empty">闂傚倸鍊风粈渚€骞栭鈶芥稑螖閸涱厾锛欓梺鑽ゅ枑鐎?/span>';

  el.innerHTML = `
    <div class="bme-cog-detail-header">
      <div class="bme-cog-detail-title-wrap">
        <div class="bme-cog-detail-name" title="${_escHtml(displayInfo.tooltip)}">${_escHtml(displayInfo.title)}</div>
        <div class="bme-cog-detail-meta">${_escHtml(
          [displayInfo.subtitle, selectedOwner.ownerKey || ""].filter(Boolean).join(" 闂?"),
        )}</div>
      </div>
      ${
        selectedOwner.ownerKey === activeOwnerKey ||
        activeOwnerKeys.includes(selectedOwner.ownerKey)
          ? '<span class="bme-cog-detail-badge">闂備浇宕甸崰鎰垝鎼淬垺娅犳俊銈呮噹缁犱即鏌涘☉姗堟敾婵炲懐濞€閺岋絽螣濞嗘儳娈梺鍦嚀閻栧ジ寮婚敐澶婄闁绘劕妫欓崹鍧楀箖閻㈠壊鏁嶉柣鎰ˉ閹锋椽姊洪崷顓х劸閻庢稈鏅犻幆鍐箣閿旂晫鍘?/span>'
          : ""
      }
    </div>

    <div class="bme-cog-metrics">
      <div class="bme-cog-metric">
        <div class="bme-cog-metric__label"><span class="bme-cog-metric-dot dot-known"></span> 闂備浇顕у锕傦綖婢舵劖鍋ら柡鍥╁С閻掑﹥绻涢崱妯诲鞍闁稿鍊块弻銊╂偄閸濆嫅锝夋煟閹惧崬鍔滈柟渚垮妼铻ｉ柛婵嗗閸╃偞绻?/div>
        <div class="bme-cog-metric__value">${Number(selectedOwner.knownCount || 0)}</div>
      </div>
      <div class="bme-cog-metric">
        <div class="bme-cog-metric__label"><span class="bme-cog-metric-dot dot-mistaken"></span> 闂傚倷娴囧畷鍨叏閺夋嚚褰掑磼閻愭彃鐎繛杈剧到閸犳岸寮虫导瀛樷拻濞达絽鎼敮鍫曟煙绾板崬浜扮€规洘鍔栫换婵嗩潩椤掑偊绱?/div>
        <div class="bme-cog-metric__value">${Number(selectedOwner.mistakenCount || 0)}</div>
      </div>
      <div class="bme-cog-metric">
        <div class="bme-cog-metric__label"><span class="bme-cog-metric-dot dot-visible"></span> 闂備浇顕х€涒晠顢欓弽顓炵獥闁哄稁鍘肩粻瑙勩亜閹扳晛鍔樺ù婊冪秺閺屻倗鍠婇崡鐐差潽闂?/div>
        <div class="bme-cog-metric__value">${strongVisibleNames.length}</div>
      </div>
      <div class="bme-cog-metric">
        <div class="bme-cog-metric__label"><span class="bme-cog-metric-dot dot-suppressed"></span> 闂傚倷娴囧畷鐢稿磻閻愬搫绀勭憸鐗堝笒绾惧鏌涢弴銊ュ箺闁哄棙绮撻弻娑㈠Ψ椤旂厧顫╃紓浣插亾?/div>
        <div class="bme-cog-metric__value">${suppressedCount}</div>
      </div>
    </div>

    <div class="bme-cog-chip-section">
      <div class="bme-cog-chip-label">闂備浇顕х€涒晠顢欓弽顓炵獥闁哄稁鍘肩粻瑙勩亜閹扳晛鍔樺ù婊冪秺閺屻倗鍠婇崡鐐差潽闂佸摜濮村Λ妤呮箒闂佹寧绻傞悧濠囁夋径鎰嚉闁跨喓濮甸埛?闂?ACTIVE VISIBILITY</div>
      <div class="bme-cog-chip-wrap">${visChips}</div>
    </div>
    <div class="bme-cog-chip-section">
      <div class="bme-cog-chip-label">闂傚倷娴囧畷鐢稿磻閻愬搫绀勭憸鐗堝笒绾惧鏌涢弴銊ュ箺闁哄棙绮撻弻娑㈠Ψ椤旂厧顫╃紓浣插亾闁糕剝绋掗悡娆愩亜閺嶃劎鈯曠紒鑸电叀閹藉爼鏁撻悩鏂ユ嫼?闂?SUPPRESSED</div>
      <div class="bme-cog-chip-wrap">${supChips}</div>
    </div>

    <div class="bme-cog-override-section">
      <div class="bme-cog-override-title">闂傚倷娴囬褍霉閻戣棄鏋侀柟闂寸缁犵娀鏌熼幆褍顣崇紒鈧繝鍥ㄥ€甸柨婵嗛閺嬫稓绱掗埀顒勫醇閳垛晛浜炬鐐茬仢閸旀碍銇勯敂璇蹭喊鐎规洘鍨块獮姗€寮堕幋鐘电嵁濠电姰鍨煎▔娑欘殽閹间胶宓侀柍褜鍓熷缁樻媴閸濆嫬浠橀梺鍦拡閸嬪﹤鐣烽幇顓犵瘈婵﹩鍓涢敍娑㈡⒑閹稿海绠撴い锔诲灣婢规洜绱掑Ο璇插伎濠殿喗顨呭Λ妤呯嵁閺嶃劊浜滈柕鍫濆缁愭棃鏌＄仦鍓ф创鐎殿噮鍓涢幏鐘诲箵閹烘繃缍傚┑锛勫亼閸婃劙寮查埡鍛；濠电姴娲ょ粻?/div>
      <div class="bme-cog-override-status">${
        selectedNode
          ? `闂備浇宕甸崰鎰垝鎼淬垺娅犳俊銈呮噹缁犱即鏌涘☉姗堟敾婵炲懐濞€閺岋絽螣閼测晛绗￠梺鎼炲€曠粔褰掑蓟濞戞矮娌柛鎾楀懐鍘愬┑鐐差嚟婵參宕归崼鏇炶摕?{_escHtml(selectedNodeLabel)} 闂?<span class="bme-cog-status-pill is-${selectedNodeState}">${_escHtml(selectedNodeStateLabel)}</span>`
          : "闂傚倸鍊烽懗鍫曗€﹂崼銏″床闁规壆澧楅崑瀣煕閳╁喚娈ｉ柤鐗堝閵囧嫯绠涢幘鎼闂佺顑嗛幑鍥х暦閻戠瓔鏁囬柣鎰閸曞啯绻濈喊澶岀？闁稿鐩畷鎰板垂椤旂偓娈鹃梺鍓插亝濞叉牜绮婚弻銉︾厵闂侇叏绠戦獮妯荤箾閸稑鈧繂顫忓ú顏呭仭闁规鍠楅幉濂告⒑缂佹﹩娈橀柛瀣ㄥ€濋妴浣糕枎閹惧磭鍊炲銈呯箰濡盯寮堕幖浣光拺缂侇垱娲栨晶鍙夈亜閵娿儲鍤囬柟顔矫埢搴ㄥ箻閺夋垳鍝楁繝鐢靛仦閸ㄥ爼鎮ч弴鐔剁箚婵炲樊浜濋悡鐘绘煕椤垵浜滈柣蹇旀尦閺岋紕浠﹂懞銉ユ閻庡灚婢樼€氼厼顕ラ崟顒佸劅闁炽儱纾悾杈ㄧ節閻㈤潧浠﹂柛銊ョ埣楠炴劙骞橀鑲╋紱闂佸湱鍋撻弸鐓幬ｉ崼銉︾厵闁割煈鍠栭弳鏇熺箾閺夋垵妲婚柍瑙勫灴閸┿儵宕卞Δ鈧猾宥夋⒑鐠団€虫灍闁荤啿鏅犻幃浼搭敊閼恒儱鍔呴梺瑙勫劤閸樻牗绔?
      }</div>
      <div class="bme-cog-override-actions">
        <button class="bme-cog-btn bme-cog-btn--known" type="button" data-bme-cognition-node-action="known" ${disabledAttr}>闂備浇顕х€涒晠顢欓弽顓炵獥闁哄稁鍘肩粻瑙勩亜閹板墎鐣遍柡鍕╁劜娣囧﹪濡堕崒姘婵＄偑鍊栭弻銊ф崲濮椻偓楠炲﹪鎮╁ú缁樻櫌闂佺鏈懝鍓х磼?/button>
        <button class="bme-cog-btn bme-cog-btn--hidden" type="button" data-bme-cognition-node-action="hidden" ${disabledAttr}>闂備浇顕х€涒晠顢欓弽顓炵獥闁哄稁鍘肩粻瑙勩亜閹板墎鐣遍柡鍕╁劜娣囧﹪濡堕崨顔兼闂佹娊鏀卞ú鐔煎蓟閻斿吋鐒介柨鏇楀亾闁诲繆鍓濋妵?/button>
        <button class="bme-cog-btn bme-cog-btn--mistaken" type="button" data-bme-cognition-node-action="mistaken" ${disabledAttr}>闂傚倸鍊风粈渚€骞栭銈囩煋闁哄鍤氬ú顏勭厸闁告粈鐒﹂弲鈺呮⒑閹肩偛鍔楅柡鍛矌閳ь剚纰嶇喊宥夊Φ閸曨垰鍐€闁靛ě鍕拡?/button>
        <button class="bme-cog-btn bme-cog-btn--clear" type="button" data-bme-cognition-node-action="clear" ${disabledAttr}>婵犵數濮烽弫鎼佸磻閻愬搫绠伴柟闂寸缁犵姵淇婇婵勨偓鈧柡瀣Ч楠炴牗娼忛崜褏蓱闂佸摜鍠愬浠嬪蓟濞戙垹鐒洪柛鎰典簼閸ｎ厾绱?/button>
      </div>
    </div>
  `;
}

function _renderCogSpaceTools(graph, loadInfo, canRender) {
  const el = document.getElementById("bme-cog-space-tools");
  if (!el) return;

  if (!canRender) { el.innerHTML = ""; return; }

  const regionState = graph?.regionState || {};
  const historyState = graph?.historyState || {};
  const timelineState = graph?.timelineState || {};
  const activeRegion = String(
    historyState.activeRegion || historyState.lastExtractedRegion || regionState.manualActiveRegion || "",
  ).trim();
  const activeStoryTimeLabel = String(
    historyState.activeStoryTimeLabel || "",
  ).trim();
  const adjacentRegions = Array.isArray(regionState?.adjacencyMap?.[activeRegion]?.adjacent)
    ? regionState.adjacencyMap[activeRegion].adjacent : [];
  const writeBlocked = _isGraphWriteBlocked(loadInfo);
  const disabledAttr = writeBlocked ? "disabled" : "";
  const manualStorySegmentId = String(timelineState.manualActiveSegmentId || "").trim();

  el.innerHTML = `
    <div class="bme-cog-space-row">
      <label>闂傚倸鍊风粈浣虹礊婵犲偆鐒界憸鏃堛€侀弽顓炲窛妞ゆ棁妫勫鍧楁⒑閸愬弶鎯堥悗姘ュ妽缁傚秷銇愰幒鎾跺幍闂佽鍨庨崘鈺傜槪婵＄偑鍊戦崐鏇㈠箠濮椻偓瀵鈽夐姀鈩冩珕闂佸吋浜介崕鎶藉礄閿熺姵鐓?/label>
      <input class="bme-config-input" type="text" id="bme-cog-manual-region"
             placeholder="闂傚倷绀侀幖顐λ囬鐐村亱濠电姴娲ょ粻浼存煙闂傚顦﹂柣顓燁殜閺屾盯鍩勯崘顏佹闂佸湱鎳撻悥濂稿蓟閳╁啫绶炲┑鐘插閾忓酣姊婚崒姘櫤闁挎洏鍨藉璇测槈濮楀棙鍍靛銈嗗笒閸婃劙濡堕崶銊ヤ粡?.." value="${_escHtml(regionState.manualActiveRegion || activeRegion || "")}" ${disabledAttr} />
      <div class="bme-cog-space-btn-row">
        <button class="bme-cog-btn bme-cog-btn--known" type="button" id="bme-cog-region-apply" ${disabledAttr}>
          <i class="fa-solid fa-location-dot"></i> 闂傚倷娴囧畷鍨叏瀹曞洨鐭嗗ù锝咁潟娴滃綊鏌ｉ幇顒備粵閻庢艾顭烽弻锝夊籍閳ь剟鎯囩憴鍕洸鐟滅増甯楅悡娆撴煙椤栧棗鍟В鎰渻閵堝啫鈧洟骞婂鈧璇测槈閵忊剝娅嗛梺鍏间航閸庢娊宕欓敓鐘崇厽?
        </button>
        <button class="bme-cog-btn bme-cog-btn--clear" type="button" id="bme-cog-region-clear" ${disabledAttr}>
          <i class="fa-solid fa-rotate-left"></i> 闂傚倸鍊峰ù鍥敋閺嶎厼鍌ㄧ憸鐗堝笒閸ㄥ倻鎲搁悧鍫濆惞闁搞儺鍓欓拑鐔兼煏婢舵稓鐣辨繛鍫熺矊椤啴濡堕崨顖滎唶闁诲孩鍑归崜婵嬄?
        </button>
      </div>
    </div>
    <div class="bme-cog-space-row">
      <label>闂備浇宕甸崰鎰垝鎼淬垺娅犳俊銈呮噹缁犱即鏌涘☉姗堟敾婵炲懐濞€閺岋絽螣濞嗘儳娈梺鍦嚀閻栧ジ寮婚埄鍐ㄧ窞濠电姴瀚搹搴ㄦ⒒閸屾碍鍣洪柨鏇樺灩椤繐煤椤忓秵鏅ｉ梺缁橈耿濞佳呯箔閿熺姵鐓?/label>
      <input class="bme-config-input" type="text" id="bme-cog-adjacency-input"
             placeholder="濠电姷鏁搁崑鐐哄箰婵犳碍鍤屽Δ锝呭枤閺佸嫰鏌涘☉娆戞殬闁逞屽墮閹虫捇藝瑜版帗鐓涘ù锝呮憸瀛濆銈庡亝缁诲牓銆佸Δ鍛劦妞ゆ帒瀚弸渚€鏌涢幘鑼额唹闁? 婵犵數濮烽弫鎼佸磻閻愬搫绠归柍鍝勬噹閸ㄥ倿鏌熷畡鎷岊潶濞? 闂傚倸鍊烽懗鍫曞储瑜旈獮鏍敃閵忋垺娈惧銈嗗坊閸嬫捇鎮? value="${_escHtml(adjacentRegions.join(", "))}" ${disabledAttr} />
      <div class="bme-config-help" style="font-size:10px;margin-top:2px">濠电姷鏁搁崑鐘诲箵椤忓棛绀婇柍褜鍓氱换娑欏緞鐎ｎ偆顦伴悗?"," 闂傚倸鍊风粈渚€骞夐敍鍕殰闁圭儤鍤﹀☉妯锋斀闁糕€崇箲閻忎線鎮峰鍐€楁い鏇樺劦瀹曠喖顢曢锝呭厞婵＄偑鍊栭崝褏绮婚幋婵冩灁婵犻潧顑嗛埛鎴︽⒒閸碍娅婃俊缁㈠枟缁绘繈濮€閳藉棛鍔锋繛瀛樼矋閹倿銆佸☉銏″€烽柛娆忓€堕崕鐢稿蓟濞戞矮娌柛鎾楀嫬娅樼紓鍌欒兌婵磭鍒掑▎鎾崇畺婵°倐鍋撻柍钘夘槸閳诲秹顢樿闁垱顨ラ悙鎻掓殭閾绘牠鏌涘☉鍗炲箹鐎规挸妫濋弻锝嗘償閵忊懇濮囬柦鍐憾閺岋綁骞橀姘闂傚倷娴囧畷鍨叏閺夋嚚娲閵堝懐锛熼梺鍛婎殘閸庢垿鎳撻崸妤佺厵缂備降鍨归弸娑氱磼閳ь剙鐣濋崟顒傚弰闂婎偄娲﹂崙鐟邦焽閹扮増鐓熼柨婵嗩槷閹茬偓鎱ㄦ繝鍐┿仢妞ゃ垺锕㈤幃鈺呮濞戞凹鍋ч梻浣圭湽閸╁嫰宕归柆宥呯闁告劘灏欓弳锔戒繆閵堝倸浜鹃梺浼欑悼閸忔ê鐣烽崼鏇ㄦ晢闁逞屽墴瀹曘垹鈻庨幘绮规嫼?/div>
      <button class="bme-cog-btn bme-cog-btn--known" type="button" id="bme-cog-adjacency-save" ${disabledAttr}>
        <i class="fa-solid fa-diagram-project"></i> 濠电姷鏁搁崕鎴犲緤閽樺娲晜閻愵剙搴婇梺绋跨灱閸嬬偤宕戦妶澶嬬厪濠电偛鐏濇俊绋棵瑰鍐Ш闁哄瞼鍠栭獮鍡氼槻闁哄棜椴搁妵鍕Χ閸涱喖娈楅梺鍝勬湰閻╊垶寮崒鐐村殟闁靛／鍐ㄦ闂備浇顕х换鎰瑰璺哄瀭闁割偅娲栭拑鐔兼煕閵夈垺娅囩痪鎯у悑娣囧﹪顢涘顓熷創濡?
      </button>
    </div>
    <div class="bme-cog-space-row">
      <label>闂傚倸鍊风粈浣虹礊婵犲偆鐒界憸鏃堛€侀弽顓炲窛妞ゆ棁妫勫鍧楁⒑閸愬弶鎯堥悗姘ュ妽缁傚秷銇愰幒鎾跺幍闂佽鍨庨崘鈺傜槪婵＄偑鍊戦崐鏇㈠箠濮椻偓瀵鈽夐姀鐘殿啋濠德板€愰崑鎾绘倵濮樼厧澧寸€规洘绮嶇€佃偐鈧稒顭囬崢鎼佹⒑閸涘﹤濮傞柛鏂块叄瀹曟椽鏁愰崱鏇犵畾?/label>
      <input class="bme-config-input" type="text" id="bme-cog-manual-story-time"
             placeholder="濠电姷鏁搁崑鐐哄箰婵犳碍鍤屽Δ锝呭枤閺佸嫰鏌涘☉娆戞殬闁逞屽墮閹虫捇藝瑜版帗鐓涘ù锝呮憸瀛濆銈庡亝缁诲啴锝為幋锕€鍐€鐟滃秵绔熺€ｎ亖鏀介柣鎰皺閹界姷绱掗鑲╃劯闁瑰磭鍠栭、娑㈡倷閸欏偊绠戦…璺ㄦ崉娓氼垳鍔搁梺閫炲苯澧悽顖椻偓宕囨殾闁靛ň鏅╅弫濠囨煟閿濆懓瀚扮紓?/ 闂傚倸鍊风粈渚€骞栭銈傚亾濮樸儱濮傜€规洘绻傞悾婵嬪礉缁楀搫濡介柟宄版嚇瀹曠兘顢樺☉娆戜簽闂備浇顕ч崙鐣岀礊閸℃顩叉繝闈涱儏绾?/ 闂傚倸鍊烽悞锕傚箖閸洖纾块柟鎯版绾剧粯绻涢幋鐐殿暡鐎规洘鐓￠弻娑樼暆閳ь剟宕戦悙鐑樺亗闁稿本澹曢崑鎾诲礂婢跺﹣澹曢梻渚€鈧偛鑻晶顕€鏌嶇紒妯诲磳妤犵偛顑夐幃鈺呮濞戞袝闂傚倷绶氬褔藝椤撱垹纾块弶鍫氭杹閸嬫捇鏁愰崒姘" value="${_escHtml(manualStorySegmentId ? activeStoryTimeLabel : activeStoryTimeLabel || "")}" ${disabledAttr} />
      <div class="bme-config-help" style="font-size:10px;margin-top:2px">闂傚倸鍊峰鎺旀椤旀儳绶ゅΔ锝呭暞閸嬶紕鎲搁弮鍫濇槬闁绘劕鎼崘鈧銈嗗姧缁茶姤绂掗幒妤佲拺闂傚牊涓瑰☉娆愬濡炲閰ｉ埞蹇涙⒒閸屾瑦绁版い鏇熺墵瀹曘垼銇愰幒鎴濈€悷婊呭瀹曠敻宕堕鈧拑鐔兼煏婢舵稓鐣辨繛鍫熺矊椤啴濡堕崨顖滎唶闁诲孩鍑归崜婵嬄烽崟顓犵＝闁稿本鑹鹃埀顒勵棑缁牊绗熼埀顒勫箖濞差亜惟闁挎棁妫勫鍧楁⒑闂堟稓绠為柛濠冪墵瀵煡顢楁担铏诡啎闂佺懓顕崑鐔兼儗瀹€鈧槐鎺楁偐閼碱剛楔濠殿喖锕ュ浠嬬嵁閹捐绠抽柡鍥╁剱娴煎啴鏌ｉ悢鍝ョ煁濠碘剝鎮傚畷銊╊敍濠婃劗搴婇梻浣筋嚙鐎涒晝绮欓幒妤佹櫔闁荤偞纰嶉敃銏ゅ箖瀹勯偊鐓ラ柛娑卞弾閺嗩參姊洪崷顓х劸闁硅绻濆鏌ュ醇閺囩喎浜归柣鐘叉穿鐏忔瑩藝椤撱垺鍋℃繝濠傚暣閸欏嫮鈧娲樺ú婵堢不濞戞ǚ妲堟俊顖濆亹濞煎姊绘担绋款棌闁稿鎳庣叅婵せ鍋撻柡浣哥Ч閹垽宕楅懖鈺佸汲婵犵數鍋為崹鍫曟晪濡炪們鍔嶉悷褏妲愰幒鎳虫棃鍩€椤掑媻鍥箥椤旂懓浜鹃柣銏ゆ涧鐢埖銇勯锝囩疄妞ゃ垺锕㈤幃銏ゅ川婵犲嫭顫濋梻鍌氬€风粈渚€骞夐敓鐘茬闁哄稁鍘介崑锟犳煥閺冨洤袚婵炲懐濮烽埀顒€绠嶉崕閬嵥囬婧惧亾濮橆剦妲告い顓℃硶閹瑰嫬煤椤忓秮鍋撳Δ鍛嚉闁跨喓濮甸埛鎴犵磽娴ｅ顏呮叏閸モ晝纾奸柣妯垮皺鏁堥梺绯曟杹閸?/div>
      <div class="bme-cog-space-btn-row">
        <button class="bme-cog-btn bme-cog-btn--known" type="button" id="bme-cog-story-time-apply" ${disabledAttr}>
          <i class="fa-solid fa-clock"></i> 闂傚倷娴囧畷鍨叏瀹曞洨鐭嗗ù锝咁潟娴滃綊鏌ｉ幇顒備粵閻庢艾顭烽弻锝夊籍閳ь剟鎯囩憴鍕洸鐟滅増甯楅悡娆撴煙椤栧棗鍟В鎰渻閵堝啫鈧洟骞婂鈧璇测槈閵忕姷顔掑┑掳鍊愰崑鎾绘倵濮樼厧澧寸€规洘绮嶇€佃偐鈧稒顭囬崢鎼佹⒑閸涘﹤濮傞柛鏂块叄瀹曟椽鏁愰崱鏇犵畾?
        </button>
        <button class="bme-cog-btn bme-cog-btn--clear" type="button" id="bme-cog-story-time-clear" ${disabledAttr}>
          <i class="fa-solid fa-rotate-left"></i> 闂傚倸鍊峰ù鍥敋閺嶎厼鍌ㄧ憸鐗堝笒閸ㄥ倻鎲搁悧鍫濆惞闁搞儺鍓欓拑鐔兼煏婢舵稓鐣辨繛鍫熺矊椤啴濡堕崨顖滎唶闁诲孩鍑归崜婵嬄?
        </button>
      </div>
    </div>
  `;
}

function _renderCogMonitorMini() {
  const el = document.getElementById("bme-cog-monitor-mini");
  if (!el) return;

  const settings = _getSettings?.() || {};
  if (settings.enableAiMonitor !== true) {
    el.innerHTML = `<div class="bme-cog-monitor-empty">濠电姷鏁搁崑娑㈩敋椤撶喐鍙忓Δ锝呭枤閺佸鎲告惔銊ョ疄闁靛ň鏅滈崑鍕煕韫囨洖甯堕柛鎿冨櫍濮婅櫣娑甸崨顔兼锭缂傚倸绉村Λ妤呪€﹂崶顒€绠虫俊銈勮兌閸橀亶姊洪幐搴ｇ畵闁哥噥鍋呮穱濠冪附閸涘﹦鍘遍梺瑙勬儗閸ㄥ磭寮ч埀顒勬倵鐟欏嫭绀冩い銊ワ躬閻涱喗鎯旈妸锕€娈熼梺闈涱樈閸ㄥ啿顔?/div>`;
    return;
  }

  const runtimeDebug = _getRuntimeDebugSnapshot?.() || {};
  const timeline = Array.isArray(runtimeDebug?.runtimeDebug?.taskTimeline)
    ? runtimeDebug.runtimeDebug.taskTimeline : [];

  if (!timeline.length) {
    el.innerHTML = `<div class="bme-cog-monitor-empty">闂傚倸鍊风粈渚€骞栭鈶芥稑螖閸涱厾锛欓梺鑽ゅ枑鐎氬牆鈽夐姀鐘栄囨煕閳╁啰鎳愭繛鏉戝閺岋綁鎮╅崣澶婎槱閻熸粍婢橀崯鎾晲閻愬搫围闁糕剝鐟ч鏇犵磽閸屾氨澧㈠┑顔惧厴瀹曟繂顓兼径瀣幍?/div>`;
    return;
  }

  el.innerHTML = timeline
    .slice(-8)
    .reverse()
    .map((entry) => {
      const status = String(entry?.status || "").toLowerCase();
      const statusClass = status.includes("error") || status.includes("fail") ? "is-error"
        : status.includes("run") ? "is-running" : "is-success";
      const taskType = String(entry?.taskType || "unknown");
      const route =
        _getMonitorRouteLabel(entry?.route) ||
        _getMonitorRouteLabel(entry?.llmConfigSourceLabel) ||
        String(entry?.model || "").trim();
      const durationMs = Number(entry?.durationMs);
      const durationText = Number.isFinite(durationMs) && durationMs > 0
        ? durationMs >= 1000 ? `${(durationMs / 1000).toFixed(1)}s` : `${Math.round(durationMs)}ms`
        : "闂?;
      return `
        <div class="bme-cog-monitor-entry ${statusClass}">
          <span class="bme-cog-monitor-badge">${_escHtml(_getMonitorTaskTypeLabel(taskType))}</span>
          <span class="bme-cog-monitor-info">${_escHtml(route || _getMonitorStatusLabel(entry?.status) || "闂?)}</span>
          <span class="bme-cog-monitor-duration">${_escHtml(durationText)}</span>
        </div>`;
    })
    .join("");
}

// ==================== 缂傚倸鍊搁崐椋庣矆娓氣偓钘濋柟鍓佺摂閺佸鎲告惔銊ョ疄闁靛ň鏅涢悡娑㈡煕閹板吀绨荤€规洏鍎遍—鍐Χ閸℃瑥顫х紒鐐緲缁夊墎鍒掔€ｎ喖閱囬柕澶涚畱娴狀垶鏌ｆ惔顖滅У闁告ê澧介懞閬嶅箰鎼存稐绨诲銈嗗姂閸╁嫰宕曢弮鍌楀亾?====================

function _switchMobileGraphView(view) {
  const section = document.getElementById("bme-mobile-graph-section");
  if (!section) return;

  section.querySelectorAll(".bme-mobile-graph-tab").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.mobileView === view);
  });
  section.querySelectorAll(".bme-mobile-view-pane").forEach((pane) => {
    pane.classList.toggle("active", pane.dataset.mobileView === view);
  });

  if (view === "summary") _refreshMobileSummary();
  if (view === "cognition") _refreshMobileCognition();
}

function _refreshMobileSummary() {
  const el = document.getElementById("bme-mobile-summary-pane");
  if (!el) return;

  const graph = _getGraph?.();
  const loadInfo = _getGraphPersistenceSnapshot();
  if (!graph || !_canRenderGraphData(loadInfo)) {
    el.innerHTML = `<div class="bme-cog-monitor-empty">${_escHtml(_getGraphLoadLabel(loadInfo?.loadState))}</div>`;
    return;
  }

  const activeNodes = graph.nodes.filter((n) => !n.archived);
  const archivedCount = graph.nodes.filter((n) => n.archived).length;
  const typeMap = {};
  for (const node of activeNodes) {
    const t = String(node.type || "unknown");
    typeMap[t] = (typeMap[t] || 0) + 1;
  }
  const typePills = Object.entries(typeMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([type, count]) => `<span class="bme-cog-chip">${_escHtml(type)} ${count}</span>`)
    .join("");

  const recentNodes = [...activeNodes]
    .sort((a, b) => (Number(b.seqRange?.[1] || b.seqRange?.[0] || 0)) - (Number(a.seqRange?.[1] || a.seqRange?.[0] || 0)))
    .slice(0, 5);
  const recentHtml = recentNodes.map((n) => {
    const name = getNodeDisplayName(n);
    const type = String(n.type || "");
    return `<div class="bme-cog-monitor-entry is-success" style="border-left-color:var(--bme-primary)">
      <span class="bme-cog-monitor-badge">${_escHtml(type)}</span>
      <span class="bme-cog-monitor-info">${_escHtml(name)}</span>
    </div>`;
  }).join("");

  el.innerHTML = `
    <div class="bme-cog-status-strip" style="grid-template-columns:repeat(3,1fr);margin-bottom:10px">
      <div class="bme-cog-status-card"><div class="bme-cog-status-card__label">婵犵數濮烽弫鎼佸磻濞戞﹩鍤曢悹杞扮秿閿濆绠抽柡鍐ㄥ€婚悡?/div><div class="bme-cog-status-card__value">${activeNodes.length}</div></div>
      <div class="bme-cog-status-card"><div class="bme-cog-status-card__label">闂?/div><div class="bme-cog-status-card__value">${graph.edges.length}</div></div>
      <div class="bme-cog-status-card"><div class="bme-cog-status-card__label">闂備浇宕甸崰鎰垝鎼淬垺娅犳俊銈呭暞閺嗘粍淇婇妶鍛櫣鏉?/div><div class="bme-cog-status-card__value">${archivedCount}</div></div>
    </div>
    <div class="bme-cog-chip-section" style="margin-bottom:10px">
      <div class="bme-cog-chip-label">缂傚倸鍊搁崐椋庢閿熺姴纾诲鑸靛姦閺佸鎲搁弮鍫濈畺婵°倕鎳忛崐濠氭煢濡警妲烘い锔诲亰濮婅櫣鍖栭弴鐐测拤濡炪們鍔岄悧鎾汇€?/div>
      <div class="bme-cog-chip-wrap">${typePills || '<span class="bme-cog-chip is-empty">闂傚倸鍊风粈渚€骞栭鈶芥稑螖閸涱厾锛欓梺鑽ゅ枑鐎?/span>'}</div>
    </div>
    <div class="bme-cog-chip-label" style="margin-bottom:6px">闂傚倸鍊风粈渚€骞栭锔藉亱闁告劦鍠栫壕濠氭煙閹规劦鍤欑紒鐙欏洦鐓冮柛婵嗗閳ь剚鎮傞幃姗€宕￠悙鈺傛杸闂佸疇妫勫Λ妤€顕ｉ鈧弻?/div>
    <div class="bme-cog-monitor-mini">${recentHtml || '<div class="bme-cog-monitor-empty">闂傚倸鍊风粈渚€骞栭鈶芥稑螖閸涱厾锛欓梺鑽ゅ枑鐎?/div>'}</div>
  `;
}

function _refreshMobileCognition() {
  const el = document.getElementById("bme-mobile-cognition-pane");
  if (!el) return;

  const graph = _getGraph?.();
  const loadInfo = _getGraphPersistenceSnapshot();
  if (!graph) { el.innerHTML = ""; return; }

  const canRender =
    Boolean(graph) &&
    (_canRenderGraphData(loadInfo) || loadInfo.loadState === "empty-confirmed");

  if (!canRender) {
    el.innerHTML = `<div class="bme-cog-monitor-empty">${_escHtml(_getGraphLoadLabel(loadInfo.loadState))}</div>`;
    return;
  }

  const { owners, activeOwnerKey, activeOwner, activeOwnerKeys, activeOwnerLabels } =
    _getCurrentCognitionOwnerSummary(graph);
  const collisionIndex = _buildOwnerCollisionIndex(owners);
  const historyState = graph?.historyState || {};
  const regionState = graph?.regionState || {};
  const activeRegion = String(historyState.activeRegion || historyState.lastExtractedRegion || regionState.manualActiveRegion || "").trim();
  const adjacentRegions = Array.isArray(regionState?.adjacencyMap?.[activeRegion]?.adjacent)
    ? regionState.adjacencyMap[activeRegion].adjacent : [];

  const ownerCards = owners.map((owner) => {
    const displayInfo = _getOwnerDisplayInfo(owner, collisionIndex);
    const bgColor = _ownerAvatarHsl(displayInfo.avatarSeed);
    const anchor =
      owner.ownerKey === activeOwnerKey || activeOwnerKeys.includes(owner.ownerKey)
        ? "is-active-anchor"
        : "";
    return `
      <div class="bme-cog-owner-card ${anchor}" style="min-width:unset;max-width:unset" title="${_escHtml(displayInfo.tooltip)}">
        <div class="bme-cog-avatar" style="background:${bgColor}">${_escHtml(displayInfo.avatarText)}</div>
        <div class="bme-cog-owner-card__info">
          <div class="bme-cog-owner-card__name-row">
            <div class="bme-cog-owner-card__name">${_escHtml(displayInfo.title)}</div>
            <span class="bme-cog-owner-card__badge">${_escHtml(displayInfo.typeLabel)}</span>
          </div>
          <div class="bme-cog-owner-card__stats">闂備浇顕у锕傦綖婢舵劖鍋ら柡鍥╁С閻掑﹥绻涢崱妯诲鞍闁?${Number(owner.knownCount || 0)} 闂?闂傚倷娴囧畷鍨叏閺夋嚚褰掑磼閻愭彃鐎繛杈剧到閸犳岸寮?${Number(owner.mistakenCount || 0)}</div>
        </div>
      </div>`;
  }).join("");

  el.innerHTML = `
    <div class="bme-cog-status-strip" style="grid-template-columns:repeat(2,1fr);margin-bottom:10px">
      <div class="bme-cog-status-card">
        <div class="bme-cog-status-card__label"><i class="fa-solid fa-user"></i> 闂傚倸鍊风欢姘焽缂佹ü绻嗛柛銉墮绾惧潡鏌曢崼婵囧櫝闁哄绉电换娑㈠幢濡闉嶉梺缁樻尪閸庢煡骞堥妸銉庣喖宕崟顔肩厴濠?/div>
        <div class="bme-cog-status-card__value">${_escHtml(
          activeOwnerLabels.length > 0
            ? activeOwnerLabels.join(" / ")
            : activeOwner
              ? _getOwnerDisplayInfo(activeOwner, collisionIndex).title
              : "闂?,
        )}</div>
      </div>
      <div class="bme-cog-status-card">
        <div class="bme-cog-status-card__label"><i class="fa-solid fa-location-dot"></i> 闂備浇宕甸崰鎰垝鎼淬垺娅犳俊銈呮噹缁犱即鏌涘☉姗堟敾婵炲懐濞€閺岋絽螣濞嗘儳娈梺鍦嚀閻栧ジ寮婚埄鍐ㄧ窞濠电姴瀚搹搴ㄦ⒒?/div>
        <div class="bme-cog-status-card__value">${_escHtml(activeRegion || "闂?)}</div>
      </div>
    </div>
    <div class="bme-cog-chip-label" style="margin-bottom:6px">闂傚倷娴囧畷鍨叏閹惰姤鈷旂€广儱顦壕瑙勪繆閵堝懏鍣洪柛瀣€块弻銊モ槈濡警浠鹃梺鍝ュТ濡繈寮婚悢鍏煎€绘俊顖濆吹椤︺儱顪?(${owners.length})</div>
    <div style="display:flex;flex-direction:column;gap:6px">${ownerCards || '<div class="bme-cog-monitor-empty">闂傚倸鍊风粈渚€骞栭鈶芥稑螖閸涱厾锛欓梺鑽ゅ枑鐎?/div>'}</div>
  `;
}

function _formatSummaryEntryCard(entry = {}) {
  const messageRange = Array.isArray(entry?.messageRange) ? entry.messageRange : ["?", "?"];
  const extractionRange = Array.isArray(entry?.extractionRange)
    ? entry.extractionRange
    : ["?", "?"];
  const spanLabel = describeStoryTimeSpan(entry?.storyTimeSpan);
  const meta = [
    `L${Math.max(0, Number(entry?.level || 0))}`,
    String(entry?.kind || "small"),
    `闂傚倸鍊风粈浣革耿鏉堚晛鍨濇い鏍仜缁€澶愭煛閸ゅ爼顣﹀Ч?${extractionRange[0]} ~ ${extractionRange[1]}`,
    `婵?${messageRange[0]} ~ ${messageRange[1]}`,
  ].join(" 闂?");
  const hintLine = [
    Array.isArray(entry?.regionHints) && entry.regionHints.length
      ? `闂傚倸鍊风欢姘焽婵犳碍鈷旈柛鏇ㄥ亽閻斿棙淇婇鐐达紵闁? ${entry.regionHints.join(" / ")}`
      : "",
    Array.isArray(entry?.ownerHints) && entry.ownerHints.length
      ? `闂傚倷娴囧畷鐢稿窗閹扮増鍋￠柨鏃傚亾閺嗘粓鏌ｉ弬鎸庢喐闁? ${entry.ownerHints.join(" / ")}`
      : "",
    spanLabel ? `闂傚倸鍊风粈渚€骞栭锕€鐤い鎰堕檮閸嬪鏌ｉ幘鍐差唫? ${spanLabel}` : "",
  ]
    .filter(Boolean)
    .join(" 闂?");
  return `
    <div class="bme-cog-monitor-entry is-success" style="border-left-color:var(--bme-primary)">
      <span class="bme-cog-monitor-badge">${_escHtml(`L${Math.max(0, Number(entry?.level || 0))}`)}</span>
      <span class="bme-cog-monitor-info">${_escHtml(meta)}</span>
      <span class="bme-cog-monitor-duration">${_escHtml(String(entry?.kind || ""))}</span>
      <div class="bme-ai-monitor-entry__summary" style="grid-column:1/-1;margin-top:6px">
        ${_escHtml(String(entry?.text || ""))}
      </div>
      ${
        hintLine
          ? `<div class="bme-config-help" style="grid-column:1/-1;margin-top:4px">${_escHtml(hintLine)}</div>`
          : ""
      }
    </div>
  `;
}

function _refreshSummaryWorkspace() {
  const graph = _getGraph?.();
  const loadInfo = _getGraphPersistenceSnapshot();
  const workspace = document.getElementById("bme-summary-workspace");
  if (!workspace) return;

  if (!graph || !_canRenderGraphData(loadInfo)) {
    workspace.innerHTML = `
      <div class="bme-cog-monitor-empty">${_escHtml(_getGraphLoadLabel(loadInfo?.loadState))}</div>
    `;
    return;
  }

  const activeEntries = getActiveSummaryEntries(graph);
  const foldedEntries = getSummaryEntriesByStatus(graph, "folded")
    .sort(compareSummaryEntriesForDisplay)
    .slice(-12)
    .reverse();
  const summaryState = graph?.summaryState || {};
  const historyState = graph?.historyState || {};
  const debugText = [
    `闂傚倸鍊风粈渚€骞栭锔藉亱闁告劦鍠栫壕濠氭煙閹规劦鍤欑紒鐙欏洦鐓冮柛婵嗗閳ь剚鎮傞幃姗€濡烽埡鍌滃幈闂佽鎯岄崹宕囧姬閳ь剙螖閻橀潧浜归柛瀣崌濮婃椽鎮℃惔顔界稐闂佺锕ラ〃鍛村煝閺冨牆顫呴柕鍫濇閸樼數绱撻崒娆戝妽闁挎艾鈹戦鍏煎窛闁瑰弶鎮傚鍫曞箰鎼达紕鐛╅梻浣烘嚀閸㈡煡顢栨径鎰槬闁告洦鍨扮粈鍐煃閸濆嫬浜為柛鐔插亾: ${Number(summaryState.lastSummarizedExtractionCount || 0)}`,
    `闂傚倸鍊风粈渚€骞栭锔藉亱闁告劦鍠栫壕濠氭煙閹规劦鍤欑紒鐙欏洦鐓冮柛婵嗗閳ь剚鎮傞幃姗€濡烽埡鍌滃幈闂佽鎯岄崹宕囧姬閳ь剙螖閻橀潧浜归柛瀣崌濮婃椽鎮℃惔顔界稐闂佺锕ラ〃鍛村煝?assistant 婵犵數濮撮惀澶愬级鎼存挸浜炬俊銈呮噹閸屻劎鎲搁弮鍫濈畾? ${Number(summaryState.lastSummarizedAssistantFloor || -1)}`,
    `闂備浇宕甸崰鎰垝鎼淬垺娅犳俊銈呮噹缁犱即鏌涘☉姗堟敾婵?extractionCount: ${Number(historyState.extractionCount || 0)}`,
  ].join(" 闂?");

  workspace.innerHTML = `
    <div class="bme-cog-status-strip" style="grid-template-columns:repeat(3,1fr);margin-bottom:12px">
      <div class="bme-cog-status-card">
        <div class="bme-cog-status-card__label">婵犵數濮烽弫鎼佸磻濞戞﹩鍤曢悹杞扮秿閿濆绠抽柡鍐ㄥ€婚悡鏂款渻閵堝棗绗掗悗姘煎墰缁牓宕奸埗鈺佷壕妤犵偛鐏濋崝姘繆椤愶絿绠炵€?/div>
        <div class="bme-cog-status-card__value">${activeEntries.length}</div>
      </div>
      <div class="bme-cog-status-card">
        <div class="bme-cog-status-card__label">闂傚倸鍊烽懗鍫曘€佹繝鍥ф槬闁哄稁鍘介弲顏堟煟閻斿摜鐭屽褎顨呰灋闁告劑鍔庨弳锕傛煏韫囧鈧洟鐛姀鈥茬箚闁靛牆鍊告禍楣冩⒑?/div>
        <div class="bme-cog-status-card__value">${getSummaryEntriesByStatus(graph, "folded").length}</div>
      </div>
      <div class="bme-cog-status-card">
        <div class="bme-cog-status-card__label">summaryState</div>
        <div class="bme-cog-status-card__value">${summaryState.enabled === false ? "off" : "on"}</div>
      </div>
    </div>

    <div class="bme-task-toolbar-row" style="margin-bottom:12px">
      <div class="bme-task-toolbar-inline">
        <button class="bme-config-secondary-btn" id="bme-summary-generate" type="button">缂傚倸鍊搁崐鐑芥倿閿曞倸钃熼柕濞炬櫓閺佸嫰鏌涘☉鍗炲箻闁哄棎鍊濋弻娑㈠焺閸愵亖濮囬梺绋款儍閸旀垿寮婚敐澶婄睄闁稿被鍊楅崝鎼佹⒑鐠囪尙绠版繛宸弮楠炲啫螣鐠恒劎鏉搁梺瑙勫劤婢у酣顢欐径鎰拺闂侇偆鍋涢懟顖涙櫠閼碱兘鍋撶憴鍕闁轰焦鎮傚畷?/button>
        <button class="bme-config-secondary-btn" id="bme-summary-rollup" type="button">缂傚倸鍊搁崐鐑芥倿閿曞倸钃熼柕濞炬櫓閺佸嫰鏌涘☉鍗炲箻闁哄棎鍊濋弻娑㈠焺閸愵亖妲堢紓浣哄О閸庢娊骞夐幖浣哥闁挎棁銆€閸嬫挻绗熼埀顒勭嵁鐎ｎ喗鏅濋柍褜鍓涚划濠氼敊閹存帞绠氬銈嗙墬绾板秹骞嗛崼銏㈢＝?/button>
        <button class="bme-config-secondary-btn" id="bme-summary-rebuild" type="button">闂傚倸鍊搁崐鐑芥倿閿曚降浜归柛鎰典簽閻捇鎮楅棃娑欐喐缁惧彞绮欓弻鐔煎箲閹伴潧娈紓浣哄У閸ㄥ潡寮婚妶鍡樺弿闁归偊鍏橀崑鎾澄旈埀顒勫煝閺冨牆顫呴柕鍫濇閸樿棄鈹戦埥鍡楃仩闁诲繑绻堥幃锟犲箛閻楀牏鍘?/button>
        <button class="bme-config-secondary-btn bme-task-btn-danger" id="bme-summary-clear" type="button">婵犵數濮烽弫鎼佸磻閻愬搫绠伴柟闂寸缁犵娀鏌熼悧鍫熺凡闁绘挻锕㈤弻鈥愁吋鎼粹€崇缂備胶濮甸崹鍧楀蓟閵堝棙鍙忛柟閭﹀厴閸嬫挸螖閳ь剟鍩㈤弮鍫濐潊闁靛牆妫涢崢钘夆攽閳藉棗鐏犻柣蹇旂箞閹繝骞囬悧鍫㈠帗?/button>
      </div>
    </div>

    <div class="bme-config-help" style="margin-bottom:12px">${_escHtml(debugText)}</div>

    <div class="bme-cog-section-title"><i class="fa-solid fa-layer-group"></i> 婵犵數濮烽弫鎼佸磻濞戞﹩鍤曢悹杞扮秿閿濆绠抽柡鍐ㄥ€婚悡鏂款渻閵堝棗绗掗悗姘煎墰缁骞嬮敂鐣屽幘婵犳鍠楅崝鏇㈠焵椤掍緡娈旈柍缁樻婵偓闁靛牆妫涢崢閬嶆⒑鐟欏嫬鍔ょ痪缁㈠幗閻楀酣姊?/div>
    <div class="bme-cog-monitor-mini" style="margin-bottom:14px">
      ${activeEntries.length > 0
        ? activeEntries.map((entry) => _formatSummaryEntryCard(entry)).join("")
        : '<div class="bme-cog-monitor-empty">闂備浇宕甸崰鎰垝鎼淬垺娅犳俊銈呮噹缁犱即鏌涘☉姗堟敾婵炲懐濞€閺岋絽螣閹稿海褰ф繛瀛樺殠閸婃牗绌辨繝鍥舵晬婵犻潧妫楅幆鐐测攽椤旂》韬紒鐘崇墵瀵鏁撻悩鏌ュ敹濠电姴鐏氶崝鏍ㄦ櫏濠电姷顣槐鏇㈠磻閻樻祴鏋栭柡鍥ュ灩缁犳煡鏌涢弴銊ョ仩缂佲偓閸愵喗鐓冮悷娆忓閸斻倕霉濠婂牏鐣洪柡灞诲€栭幈銊╁箛椤戣棄浜炬俊銈傚亾闁崇粯妫冩慨鈧柕鍫濇閸橀亶姊虹憴鍕姢缁剧虎鍘介悧搴ㄦ⒒閸屾瑧璐伴柛鐘虫崌瀹曟繈骞嬮悙鎵畾?/div>'}
    </div>

    <div class="bme-cog-section-title"><i class="fa-solid fa-box-archive"></i> 闂傚倸鍊烽懗鍫曘€佹繝鍥ф槬闁哄稁鍘介弲顏堟煟閻斿摜鐭屽褎顨呰灋闁告劑鍔庨弳锕傛煏韫囧鈧洟鐛姀鈥茬箚闁靛牆鍊告禍楣冩⒑?/div>
    <div class="bme-cog-monitor-mini">
      ${foldedEntries.length > 0
        ? foldedEntries.map((entry) => _formatSummaryEntryCard(entry)).join("")
        : '<div class="bme-cog-monitor-empty">闂備浇宕甸崰鎰垝鎼淬垺娅犳俊銈呮噹缁犱即鏌涘☉姗堟敾婵炲懐濞€閺岋絽螣閹稿海褰ф繛瀛樺殠閸婃牗绌辨繝鍥舵晬婵犻潧妫楅幆鐐测攽椤旂》韬紒鐘崇墵瀵鏁撻悩鏌ュ敹濠电姴鐏氶崝鏍ㄦ櫏婵犵數濮甸鏍窗閺嶎厽鍎楅柛灞炬皑閺嗭箓鏌ㄥ┑鍡╂Ч闁稿鍔欓弻鐔虹磼濡櫣鐟ㄥ┑鐐插悑閸ㄥ灝顫忓ú顏勫窛濠电姴瀚崳褔姊哄ú璁崇胺闁告濞婂畷娲焵?/div>'}
    </div>
  `;
}

function _openFullscreenGraph() {
  const overlay = document.getElementById("bme-fullscreen-graph");
  if (!overlay) return;
  overlay.hidden = false;
  document.body.style.overflow = "hidden";
}

function _closeFullscreenGraph() {
  const overlay = document.getElementById("bme-fullscreen-graph");
  if (!overlay) return;
  overlay.hidden = true;
  document.body.style.overflow = "";
}



function _switchConfigSection(sectionId) {
  currentConfigSectionId = sectionId || "toggles";
  _syncConfigSectionState();
  if (currentConfigSectionId === "prompts") {
    _refreshTaskProfileWorkspace();
  } else if (currentConfigSectionId === "trace") {
    _refreshMessageTraceWorkspace();
  }
}

function _syncConfigSectionState() {
  if (!panelEl) return;
  panelEl.querySelectorAll(".bme-config-nav-btn").forEach((btn) => {
    btn.classList.toggle(
      "active",
      btn.dataset.configSection === currentConfigSectionId,
    );
  });
  panelEl.querySelectorAll(".bme-config-section").forEach((section) => {
    section.classList.toggle(
      "active",
      section.dataset.configSection === currentConfigSectionId,
    );
  });
}

// ==================== 闂傚倸鍊峰ù鍥敋閺嶎厼绀堟慨姗嗗劦閿濆绠虫俊銈咁儑缁?Tab ====================

function _refreshDashboard() {
  const graph = _getGraph?.();
  const loadInfo = _getGraphPersistenceSnapshot();
  if (!graph) return;

  if (!_canRenderGraphData(loadInfo) && loadInfo.loadState !== "empty-confirmed") {
    _setText("bme-stat-nodes", "闂?);
    _setText("bme-stat-edges", "闂?);
    _setText("bme-stat-archived", "闂?);
    _setText("bme-stat-frag", "闂?);
    _setText("bme-status-chat-id", loadInfo.chatId || "闂?);
    _setText("bme-status-history", _getGraphLoadLabel(loadInfo.loadState));
    _setText("bme-status-vector", "缂傚倸鍊搁崐鐑芥倿閿斿墽鐭欓柟娆¤娲、娑橆煥閸曢潧浠洪梻浣虹帛閺屻劑宕ョ€ｎ喖鍚归柛灞惧焹閺€浠嬫煟濡绲婚柍褜鍓濋崺鏍矉瀹ュ鏁嶉柣鎰嚟閸橀亶姊洪棃娑辨缂佺姵鍨圭划鍫ュ礃閳哄倸寮垮┑鈽嗗灣椤牊鎱ㄩ崒婧惧亾鐟欏嫭绀冩い銊ワ工閻ｅ嘲顫滈埀顒勫春閿熺姴纾兼繛鎴濆船閺呮瑩姊婚崒娆掑厡妞ゃ垹锕、姘跺冀椤撶偟鐛ラ梺鍝勭Р閸斿秹宕ｈ箛娑欑厽闁归偊鍓涢幗鐘测攽?);
    _setText("bme-status-recovery", "缂傚倸鍊搁崐鐑芥倿閿斿墽鐭欓柟娆¤娲、娑橆煥閸曢潧浠洪梻浣虹帛閺屻劑宕ョ€ｎ喖鍚归柛灞惧焹閺€浠嬫煟濡绲婚柍褜鍓濋崺鏍矉瀹ュ鏁嶉柣鎰嚟閸橀亶姊洪棃娑辨缂佺姵鍨圭划鍫ュ礃閳哄倸寮垮┑鈽嗗灣椤牊鎱ㄩ崒婧惧亾鐟欏嫭绀冩い銊ワ工閻ｅ嘲顫滈埀顒勫春閿熺姴纾兼繛鎴濆船閺呮瑩姊婚崒娆掑厡妞ゃ垹锕、姘跺冀椤撶偟鐛ラ梺鍝勭Р閸斿秹宕ｈ箛娑欑厽闁归偊鍓涢幗鐘测攽?);
    _setText("bme-status-last-extract", "缂傚倸鍊搁崐鐑芥倿閿斿墽鐭欓柟娆¤娲、娑橆煥閸曢潧浠洪梻浣虹帛閺屻劑宕ョ€ｎ喖鍚归柛灞惧焹閺€浠嬫煟濡绲婚柍褜鍓濋崺鏍矉瀹ュ鏁嶉柣鎰嚟閸橀亶姊洪棃娑辨缂佺姵鍨圭划鍫ュ礃閳哄倸寮垮┑鈽嗗灣椤牊鎱ㄩ崒婧惧亾鐟欏嫭绀冩い銊ワ工閻ｅ嘲顫滈埀顒勫春閿熺姴纾兼繛鎴濆船閺呮瑩姊婚崒娆掑厡妞ゃ垹锕、姘跺冀椤撶偟鐛ラ梺鍝勭Р閸斿秹宕ｈ箛娑欑厽闁归偊鍓涢幗鐘测攽?);
    _setText("bme-status-last-persist", "缂傚倸鍊搁崐鐑芥倿閿斿墽鐭欓柟娆¤娲、娑橆煥閸曢潧浠洪梻浣虹帛閺屻劑宕ョ€ｎ喖鍚归柛灞惧焹閺€浠嬫煟濡绲婚柍褜鍓濋崺鏍矉瀹ュ鏁嶉柣鎰嚟閸橀亶姊洪棃娑辨缂佺姵鍨圭划鍫ュ礃閳哄倸寮垮┑鈽嗗灣椤牊鎱ㄩ崒婧惧亾鐟欏嫭绀冩い銊ワ工閻ｅ嘲顫滈埀顒勫春閿熺姴纾兼繛鎴濆船閺呮瑩姊婚崒娆掑厡妞ゃ垹锕、姘跺冀椤撶偟鐛ラ梺鍝勭Р閸斿秹宕ｈ箛娑欑厽闁归偊鍓涢幗鐘测攽?);
    _setText("bme-status-last-vector", "缂傚倸鍊搁崐鐑芥倿閿斿墽鐭欓柟娆¤娲、娑橆煥閸曢潧浠洪梻浣虹帛閺屻劑宕ョ€ｎ喖鍚归柛灞惧焹閺€浠嬫煟濡绲婚柍褜鍓濋崺鏍矉瀹ュ鏁嶉柣鎰嚟閸橀亶姊洪棃娑辨缂佺姵鍨圭划鍫ュ礃閳哄倸寮垮┑鈽嗗灣椤牊鎱ㄩ崒婧惧亾鐟欏嫭绀冩い銊ワ工閻ｅ嘲顫滈埀顒勫春閿熺姴纾兼繛鎴濆船閺呮瑩姊婚崒娆掑厡妞ゃ垹锕、姘跺冀椤撶偟鐛ラ梺鍝勭Р閸斿秹宕ｈ箛娑欑厽闁归偊鍓涢幗鐘测攽?);
    _setText("bme-status-last-recall", "缂傚倸鍊搁崐鐑芥倿閿斿墽鐭欓柟娆¤娲、娑橆煥閸曢潧浠洪梻浣虹帛閺屻劑宕ョ€ｎ喖鍚归柛灞惧焹閺€浠嬫煟濡绲婚柍褜鍓濋崺鏍矉瀹ュ鏁嶉柣鎰嚟閸橀亶姊洪棃娑辨缂佺姵鍨圭划鍫ュ礃閳哄倸寮垮┑鈽嗗灣椤牊鎱ㄩ崒婧惧亾鐟欏嫭绀冩い銊ワ工閻ｅ嘲顫滈埀顒勫春閿熺姴纾兼繛鎴濆船閺呮瑩姊婚崒娆掑厡妞ゃ垹锕、姘跺冀椤撶偟鐛ラ梺鍝勭Р閸斿秹宕ｈ箛娑欑厽闁归偊鍓涢幗鐘测攽?);
    _renderStatefulListPlaceholder(
      document.getElementById("bme-recent-extract"),
      _getGraphLoadLabel(loadInfo.loadState),
    );
    _renderStatefulListPlaceholder(
      document.getElementById("bme-recent-recall"),
      _getGraphLoadLabel(loadInfo.loadState),
    );
    _refreshCognitionDashboard(graph, loadInfo);
    _refreshAiMonitorDashboard();
    return;
  }

  const activeNodes = graph.nodes.filter((node) => !node.archived);
  const archivedCount = graph.nodes.filter((node) => node.archived).length;
  const totalNodes = graph.nodes.length;
  const fragRate =
    totalNodes > 0 ? Math.round((archivedCount / totalNodes) * 100) : 0;

  _setText("bme-stat-nodes", activeNodes.length);
  _setText("bme-stat-edges", graph.edges.length);
  _setText("bme-stat-archived", archivedCount);
  _setText("bme-stat-frag", `${fragRate}%`);

  const chatId = loadInfo.chatId || graph?.historyState?.chatId || "闂?;
  const lastProcessed = graph?.historyState?.lastProcessedAssistantFloor ?? -1;
  const dirtyFrom = graph?.historyState?.historyDirtyFrom;
  const vectorStats = getVectorIndexStats(graph);
  const vectorMode = graph?.vectorIndexState?.mode || "闂?;
  const vectorSource = graph?.vectorIndexState?.source || "闂?;
  const recovery = graph?.historyState?.lastRecoveryResult;
  const extractionStatus = _getLastExtractionStatus?.() || {};
  const lastBatchStatus = _getLatestBatchStatusSnapshot();
  const vectorStatus = _getLastVectorStatus?.() || {};
  const recallStatus = _getLastRecallStatus?.() || {};
  const historyPrefix =
    loadInfo.loadState === "shadow-restored"
      ? "濠电姷鏁搁崑鐐哄垂閸洖绠伴柟闂寸劍閸嬨倝鏌曟繛鍨姶婵炴挸顭烽弻娑樼暆閳ь剟宕戝☉姘变笉闁圭儤顨嗛悡蹇涚叓閸ャ劍绀€妞ゅ骸鏈穱?闂?"
      : loadInfo.loadState === "blocked" && loadInfo.shadowSnapshotUsed
        ? "濠电姷鏁搁崕鎴犲緤閽樺娲晜閻愵剙搴婇梺鍛婂姀閺呮粓宕ｈ箛娑欑厪闊洦娲栭～宥夋煟閺冨倸甯堕柣蹇撶－閳ь剝顫夊ú鏍洪妸鈹库偓?闂?"
        : "";

  _setText("bme-status-chat-id", chatId);
  _setText(
    "bme-status-history",
    `${historyPrefix}${_formatDashboardHistoryMeta(graph, loadInfo, lastBatchStatus)}`,
  );
  _setText(
    "bme-status-vector",
    `${vectorMode}/${vectorSource} 闂?total ${vectorStats.total} 闂?indexed ${vectorStats.indexed} 闂?stale ${vectorStats.stale} 闂?pending ${vectorStats.pending}`,
  );
  _setText(
    "bme-status-recovery",
    recovery
      ? [
          recovery.status || "闂?,
          recovery.path ? `path ${recovery.path}` : "",
          recovery.detectionSource ? `src ${recovery.detectionSource}` : "",
          recovery.fromFloor != null ? `from ${recovery.fromFloor}` : "",
          recovery.affectedBatchCount != null
            ? `affected ${recovery.affectedBatchCount}`
            : "",
          recovery.replayedBatchCount != null
            ? `replayed ${recovery.replayedBatchCount}`
            : "",
          recovery.reason || "",
        ]
          .filter(Boolean)
          .join(" 闂?")
      : "闂傚倸鍊风粈渚€骞栭鈶芥稑螖閸涱厾锛欓梺鑽ゅ枑鐎氬牆鈽夐姀鐘栄冾熆鐠虹尨鍔熼柣锝嗗▕濮婃椽妫冨☉姘鳖唺婵犳鍨奸崢鐓庡祫婵犵數濮电喊宥夊磻閿濆悿褰掓晲閸偅缍堢紓浣瑰劶鐏忔瑧妲?,
  );
  _setText("bme-status-last-extract", extractionStatus.meta || "闂傚倷娴囬褏鎹㈤幇顔藉床闁瑰濮撮弸鍫⑩偓骞垮劚閹锋垿鎳撻幐搴涗簻闁规儳宕悘鈺冪磼閻橆喖鍔ら柟鍙夋倐楠炲鏁傜悰鈥充壕濞撴埃鍋撴鐐差儔閺佸啴鍩€椤掑倻涓嶉柣銏犳啞閻撴瑩姊洪銊х暠濠⒀屽枤缁?);
  _setText(
    "bme-status-last-persist",
    _formatDashboardPersistMeta(loadInfo, lastBatchStatus),
  );
  _setText("bme-status-last-vector", vectorStatus.meta || "闂傚倷娴囬褏鎹㈤幇顔藉床闁瑰濮撮弸鍫⑩偓骞垮劚閹锋垿鎳撻幐搴涗簻闁规儳宕悘鈺冪磼閻橆喖鍔ら柟鍙夋倐楠炲鏁傜悰鈥充壕濞撴埃鍋撴鐐差儔閺佸啴鍩€椤掑倹鍠嗛柨鏇炲€归悡娆撳级閸繂鈷旈柣锝堥哺缁绘盯宕ㄩ鈶╁亾閺囥垺绠掗梻浣虹帛鐪夐悹鈧敃鍌氬惞婵炲棗绻嗛弨?);
  _setText("bme-status-last-recall", recallStatus.meta || "闂傚倷娴囬褏鎹㈤幇顔藉床闁瑰濮撮弸鍫⑩偓骞垮劚閹锋垿鎳撻幐搴涗簻闁规儳宕悘鈺冪磼閻橆喖鍔ら柟鍙夋倐楠炲鏁傜悰鈥充壕濞撴埃鍋撴鐐差儔閺佸啴鍩€椤掑嫭鍎楁俊銈勯檷娴滄粓鏌熼崫鍕棞濞存粍鍎抽埞?);

  _refreshCognitionDashboard(graph);
  _refreshAiMonitorDashboard();
  _refreshMobileSummary();
  _renderRecentList("bme-recent-extract", _getLastExtract?.() || []);
  _renderRecentList("bme-recent-recall", _getLastRecall?.() || []);
}

function _renderMiniRecentList(elementId, entries = [], emptyText = "闂傚倸鍊风粈渚€骞栭鈶芥稑螖閸涱厾锛欓梺鑽ゅ枑鐎氬牆鈽夐姀鐘栄冾熆鐠虹尨鏀婚柣搴墴濮婅櫣绱掑鍡樼暥闂佺粯顨呭Λ娑氬垝?) {
  const listEl = document.getElementById(elementId);
  if (!listEl) return;
  listEl.innerHTML = "";

  if (!Array.isArray(entries) || entries.length === 0) {
    const li = document.createElement("li");
    li.className = "bme-recent-item";
    li.textContent = emptyText;
    listEl.appendChild(li);
    return;
  }

  for (const entry of entries) {
    const li = document.createElement("li");
    li.className = "bme-recent-item";
    li.textContent = String(entry || "");
    listEl.appendChild(li);
  }
}

function _setInputValueIfIdle(elementId, value = "") {
  const input = document.getElementById(elementId);
  if (!input) return;
  if (document.activeElement === input) return;
  input.value = String(value || "");
}

function _getSelectedGraphNode(graph = _getGraph?.()) {
  const detailNodeId = String(
    document.getElementById("bme-node-detail")?.dataset?.editNodeId || "",
  ).trim();
  const rendererNodeId = String(
    _getActiveGraphRenderer()?.selectedNode?.id || "",
  ).trim();
  const nodeId = detailNodeId || rendererNodeId;
  if (!nodeId || !Array.isArray(graph?.nodes)) return null;
  return graph.nodes.find((node) => String(node?.id || "") === nodeId) || null;
}

function _getCognitionOwnerCollection(graph) {
  return typeof listKnowledgeOwners === "function" ? listKnowledgeOwners(graph) : [];
}

function _getLatestRecallOwnerInfo(graph) {
  const runtimeDebug = _getRuntimeDebugSnapshot?.() || {};
  const recallInjection =
    runtimeDebug?.runtimeDebug?.injections?.recall || {};
  const retrievalMeta = recallInjection?.retrievalMeta || {};
  const owners = _getCognitionOwnerCollection(graph);
  const collisionIndex = _buildOwnerCollisionIndex(owners);
  const ownerCandidates = Array.isArray(retrievalMeta.sceneOwnerCandidates)
    ? retrievalMeta.sceneOwnerCandidates
    : [];
  const ownerKeys = Array.isArray(retrievalMeta.activeRecallOwnerKeys)
    ? retrievalMeta.activeRecallOwnerKeys.map((value) => String(value || "").trim()).filter(Boolean)
    : [];
  const fallbackOwnerKey = String(graph?.historyState?.activeRecallOwnerKey || "").trim();
  const normalizedOwnerKeys = ownerKeys.length > 0
    ? [...new Set(ownerKeys)]
    : fallbackOwnerKey
      ? [fallbackOwnerKey]
      : [];
  const ownerLabels = normalizedOwnerKeys.map((ownerKey) => {
    const ownerEntry = owners.find((entry) => entry.ownerKey === ownerKey);
    if (ownerEntry) {
      return _getOwnerDisplayInfo(ownerEntry, collisionIndex).title;
    }
    const candidateMatch = ownerCandidates.find(
      (candidate) => String(candidate?.ownerKey || "").trim() === ownerKey,
    );
    if (candidateMatch?.ownerName) {
      return _getOwnerDisplayInfo(
        {
          ownerKey,
          ownerName: candidateMatch.ownerName,
          ownerType: _inferOwnerTypeFromKey(ownerKey),
        },
        collisionIndex,
      ).title;
    }
    return _getOwnerDisplayInfo({ ownerKey }, collisionIndex).title;
  });

  return {
    ownerKeys: normalizedOwnerKeys,
    ownerLabels,
    resolutionMode: String(retrievalMeta.sceneOwnerResolutionMode || "").trim() || "fallback",
  };
}

function _getCurrentCognitionOwnerSummary(graph) {
  const owners = _getCognitionOwnerCollection(graph);
  const recallOwnerInfo = _getLatestRecallOwnerInfo(graph);
  const activeOwnerKey = String(recallOwnerInfo.ownerKeys[0] || "").trim();
  if (!owners.some((entry) => entry.ownerKey === currentCognitionOwnerKey)) {
    currentCognitionOwnerKey =
      activeOwnerKey && owners.some((entry) => entry.ownerKey === activeOwnerKey)
        ? activeOwnerKey
        : owners[0]?.ownerKey || "";
  }
  const selectedOwner =
    owners.find((entry) => entry.ownerKey === currentCognitionOwnerKey) || null;
  const activeOwner =
    owners.find((entry) => entry.ownerKey === activeOwnerKey) || null;
  return {
    owners,
    activeOwnerKeys: recallOwnerInfo.ownerKeys,
    activeOwnerLabels: recallOwnerInfo.ownerLabels,
    sceneOwnerResolutionMode: recallOwnerInfo.resolutionMode,
    activeOwnerKey,
    selectedOwner,
    activeOwner,
  };
}

function _collectNodeNames(graph, nodeIds = [], { limit = 4 } = {}) {
  const seen = new Set();
  const result = [];
  for (const nodeId of Array.isArray(nodeIds) ? nodeIds : []) {
    const normalizedNodeId = String(nodeId || "").trim();
    if (!normalizedNodeId || seen.has(normalizedNodeId)) continue;
    seen.add(normalizedNodeId);
    const node =
      Array.isArray(graph?.nodes)
        ? graph.nodes.find((item) => String(item?.id || "") === normalizedNodeId)
        : null;
    result.push(node ? getNodeDisplayName(node) : normalizedNodeId);
    if (result.length >= limit) break;
  }
  return result;
}

function _renderCognitionOwnerList(
  graph,
  { owners = [], activeOwnerKey = "", activeOwnerKeys = [] } = {},
) {
  const listEl = document.getElementById("bme-cognition-owner-list");
  if (!listEl) return;
  listEl.innerHTML = "";
  const collisionIndex = _buildOwnerCollisionIndex(owners);

  if (!owners.length) {
    const li = document.createElement("li");
    li.className = "bme-recent-item";
    li.textContent = "闂傚倸鍊风粈渚€骞栭鈶芥稑螖閸涱厾锛欓梺鑽ゅ枑鐎氬牆鈽夐姀鐘栄囨煕閵夛絽濡兼い搴㈢洴濮婃椽妫冨☉姘暫濠电偛鐪伴崝鎴濈暦閿濆鐒垫い鎺戝閻撶喖鏌ｉ弬鎸庢喐闁瑰啿瀚伴幃浠嬵敍濠婂啯鐎剧紓?;
    listEl.appendChild(li);
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const owner of owners) {
    const displayInfo = _getOwnerDisplayInfo(owner, collisionIndex);
    const li = document.createElement("li");
    li.className = "bme-cognition-owner-row";

    const button = document.createElement("button");
    button.type = "button";
    button.className = "bme-cognition-owner-btn";
    if (owner.ownerKey === currentCognitionOwnerKey) {
      button.classList.add("is-selected");
    }
    if (owner.ownerKey === activeOwnerKey || activeOwnerKeys.includes(owner.ownerKey)) {
      button.classList.add("is-active-anchor");
    }
    button.dataset.ownerKey = String(owner.ownerKey || "");
    button.title = displayInfo.tooltip;

    const title = document.createElement("div");
    title.className = "bme-cognition-owner-btn__title";
    title.textContent = displayInfo.title;

    const meta = document.createElement("div");
    meta.className = "bme-cognition-owner-btn__meta";
    meta.textContent = [
      displayInfo.subtitle,
      `闂備浇顕у锕傦綖婢舵劖鍋ら柡鍥╁С閻掑﹥绻涢崱妯诲鞍闁?${Number(owner.knownCount || 0)}`,
      `闂傚倷娴囧畷鍨叏閺夋嚚褰掑磼閻愭彃鐎繛杈剧到閸犳岸寮?${Number(owner.mistakenCount || 0)}`,
      `闂傚倸鍊搁崐鎼佸磹閹间礁绠犻煫鍥ㄧ☉缁€澶嬩繆椤栨瑧绉?${Number(owner.manualHiddenCount || 0)}`,
    ].join(" 闂?");

    button.append(title, meta);
    li.appendChild(button);
    fragment.appendChild(li);
  }
  listEl.appendChild(fragment);
}

function _renderCognitionDetail(
  graph,
  {
    selectedOwner = null,
    activeOwnerKey = "",
    activeOwnerKeys = [],
    activeRegion = "",
    adjacentRegions = [],
  } = {},
  loadInfo = _getGraphPersistenceSnapshot(),
) {
  const detailEl = document.getElementById("bme-cognition-detail");
  if (!detailEl) return;

  if (!selectedOwner) {
    detailEl.innerHTML = `
      <div class="bme-cognition-empty">
        闂傚倷绀侀幖顐λ囬锕€鐤炬繝濠傛閹冲矂姊绘担鍦菇闁稿酣浜堕獮濠偽熸笟顖氭闂佸壊鐓堥崑鍕閻愭祴鏀介柣妯诲絻閳ь兛绮欓、娆愬緞閹邦厸鎷洪梺鍛婄箓鐎氼垶锝為敃鍌涚厱閹肩补鈧櫕姣愰梺鎸庢磸閸ㄨ棄鐣烽妸褉鍋撳☉娅亪宕滈銏♀拺闁告稑锕ユ径鍕煕閿濆骸鏋涙い顓炴喘閺佹捇鎮╁畷鍥у箻缂備胶铏庨崢濂稿箠鎼淬劍瀚婇柛蹇曨儠娴滄粓鏌熼悙顒€澧柣鎾炽偢閺岀喖顢涘杈╁姱婵犵绱曢崗姗€寮幇鏉跨＜婵﹩鍋勯ˉ姘舵⒒娴ｄ警鐒鹃柡鍫墰閹广垽宕熼鐘辩瑝婵犵數濮电喊宥夋偂閺囥垻鍙撻柛銉戝苯鍓伴梺鍛婃⒐閻熝呮閹烘绫嶉柍褜鍓欓…鍥р枎閹惧磭鍘洪梺瑙勫礃椤曆囧垂閸屾稏浜滈柟浼存涧娴滄粌鈹戦埊娆忔处閻撶喖鏌曡箛濠冩珔闁诲骏绲鹃妵鍕敇閻愰潧鈪靛銈冨灪瀹€鎼併€佸▎鎾村€锋い鎺嗗亾闁绘繃婢橀埞鎴︽偐缂佹ɑ閿┑鈽嗗亝缁酣鍩€椤掍胶顣查柣鐔叉櫊楠炲啫螖閸涱喖浠梺缁橆殔閻楀﹪骞忛柆宥嗏拺闁硅偐鍋涙俊鐣屸偓鍏夊亾闁归棿鑳跺畵渚€鏌熼幑鎰靛殭缂佺姵绋掗妵鍕箳閸℃ぞ澹曠紓鍌欑劍瑜板啫顭囬敓鐘茶摕婵炴垶锕╁鈺傘亜閹哄棗浜鹃梺鎼炲€涙禍顒傛閹烘挻缍囬柕濞у懐鏆繝鐢靛仩婢瑰牓顢氳閸┿垺鎯旈妸銉ь啋闂佹儳娴氶崑鎺撶閿曗偓閳规垿鎮欑€涙绋囬梺鍛婅壘椤戝骞婂┑鍥ュ亝闁告劑鍔岄幆鐐差渻閵堝棙灏柛銊︽そ瀹曟垵鈹戠€ｎ偆鍘甸悗鐟板婢瑰棝鎮為悙顒傜缁绢參顥撶弧鈧梺鍝勮閸婃骞夐幘顔肩妞ゆ劑鍊楅妶鐑芥⒒娴ｇ顥忛柣鎾崇墛缁傚秹鎮欓崫鍕暫婵炴潙鍚嬪娆愬劔闂備線娼ч¨鈧紒鐘冲灴椤㈡棃顢涢悙瀵稿幗闂佺粯锕㈡禍璺侯瀶閻戣姤鐓曞┑鐘插枤濞堟粓鏌熼鍡欑瘈闁轰礁绉瑰畷鐔碱敆閳ь剟鎮垫导瀛樷拺闁圭瀛╅ˉ鍡樹繆椤愩垹顏€规洘绮嶇€佃偐鈧稒顭囬崢?
      </div>
    `;
    return;
  }

  const ownerState =
    graph?.knowledgeState?.owners?.[selectedOwner.ownerKey] || {
      aliases: selectedOwner.aliases || [],
      visibilityScores: {},
      manualKnownNodeIds: [],
      manualHiddenNodeIds: [],
      mistakenNodeIds: [],
      knownNodeIds: [],
      updatedAt: 0,
      lastSource: "",
    };
  const visibilityEntries = Object.entries(ownerState.visibilityScores || {})
    .map(([nodeId, score]) => ({
      nodeId: String(nodeId || ""),
      score: Number(score || 0),
    }))
    .filter((entry) => entry.nodeId)
    .sort((left, right) => right.score - left.score);
  const strongVisibleNames = _collectNodeNames(
    graph,
    visibilityEntries.filter((entry) => entry.score >= 0.68).map((entry) => entry.nodeId),
    { limit: 5 },
  );
  const suppressedNames = _collectNodeNames(
    graph,
    [
      ...(ownerState.manualHiddenNodeIds || []),
      ...(ownerState.mistakenNodeIds || []),
    ],
    { limit: 5 },
  );
  const selectedNode = _getSelectedGraphNode(graph);
  const selectedNodeLabel = selectedNode ? getNodeDisplayName(selectedNode) : "";
  const selectedNodeState = selectedNode
    ? ownerState.manualKnownNodeIds?.includes(selectedNode.id)
      ? "闂備浇顕х€涒晠顢欓弽顓炵獥闁哄稁鍘肩粻瑙勩亜閹板墎鐣遍柡鍕╁劜娣囧﹪濡堕崒姘婵＄偑鍊栭弻銊ф崲濮椻偓楠炲﹪鎮╁ú缁樻櫌闂佺鏈懝鍓х磼?
      : ownerState.manualHiddenNodeIds?.includes(selectedNode.id)
        ? "闂備浇顕х€涒晠顢欓弽顓炵獥闁哄稁鍘肩粻瑙勩亜閹板墎鐣遍柡鍕╁劜娣囧﹪濡堕崨顔兼闂佹娊鏀卞ú鐔煎蓟閻斿吋鐒介柨鏇楀亾闁诲繆鍓濋妵?
        : ownerState.mistakenNodeIds?.includes(selectedNode.id)
          ? "闂傚倷娴囧畷鍨叏閺夋嚚褰掑磼閻愭彃鐎繛杈剧到閸犳岸寮?
          : "闂傚倸鍊风粈渚€骞栭锔藉亱婵犲﹤瀚々鏌ユ煥濠靛棭妲堕柍褜鍓欓幊姗€銆侀弴銏℃櫆闁芥ê顦竟?
    : "闂傚倸鍊风粈渚€骞栭锔藉亱婵犲﹤瀚々鍙夈亜韫囨挾澧曢柣鎺戠仛閵囧嫰骞掗崱妞惧婵＄偑鍊х€靛矂宕抽敐澶婄疇婵炲棙鎸哥粻锝夋煥閺冨洦顥夋繛鍫㈠枛濮婅櫣绮欓幐搴㈡嫳缂備緡鍠栭張顒傜矉?;
  const writeBlocked = _isGraphWriteBlocked(loadInfo);
  const aliases = Array.isArray(ownerState.aliases) ? ownerState.aliases : [];
  const collisionIndex = _buildOwnerCollisionIndex(_getCognitionOwnerCollection(graph));
  const displayInfo = _getOwnerDisplayInfo(selectedOwner, collisionIndex);

  detailEl.innerHTML = `
    <div class="bme-cognition-detail-card">
      <div class="bme-config-card-head">
        <div>
          <div class="bme-config-card-title">${_escHtml(
            displayInfo.title,
          )}</div>
          <div class="bme-config-card-subtitle">
            ${_escHtml(
              [displayInfo.subtitle, String(selectedOwner.ownerKey || "")]
                .filter(Boolean)
                .join(" 闂?"),
            )}
          </div>
        </div>
        ${
          selectedOwner.ownerKey === activeOwnerKey ||
          activeOwnerKeys.includes(selectedOwner.ownerKey)
            ? '<span class="bme-task-pill">闂備浇宕甸崰鎰垝鎼淬垺娅犳俊銈呮噹缁犱即鏌涘☉姗堟敾婵炲懐濞€閺岋絽螣濞嗘儳娈梺鍦嚀閻栧ジ寮婚敐澶婄闁绘劕妫欓崹鍧楀箖閻㈠壊鏁嶉柣鎰ˉ閹锋椽姊洪崷顓х劸閻庢稈鏅犻幆鍐箣閿旂晫鍘?/span>'
            : ""
        }
      </div>

      <div class="bme-cognition-metrics">
        <div class="bme-cognition-metric">
          <span class="bme-cognition-metric__label">闂備浇顕у锕傦綖婢舵劖鍋ら柡鍥╁С閻掑﹥绻涢崱妯诲鞍闁稿鍊块弻銊╂偄閸濆嫅锝夋煟閹惧崬鍔滈柟渚垮妼铻ｉ柛婵嗗閸╃偞绻?/span>
          <strong class="bme-cognition-metric__value">${_escHtml(
            String(selectedOwner.knownCount || 0),
          )}</strong>
        </div>
        <div class="bme-cognition-metric">
          <span class="bme-cognition-metric__label">闂傚倷娴囧畷鍨叏閺夋嚚褰掑磼閻愭彃鐎繛杈剧到閸犳岸寮虫导瀛樷拻濞达絽鎼敮鍫曟煙绾板崬浜扮€规洘鍔栫换婵嗩潩椤掑偊绱?/span>
          <strong class="bme-cognition-metric__value">${_escHtml(
            String(selectedOwner.mistakenCount || 0),
          )}</strong>
        </div>
        <div class="bme-cognition-metric">
          <span class="bme-cognition-metric__label">闂備浇顕х€涒晠顢欓弽顓炵獥闁哄稁鍘肩粻瑙勩亜閹扳晛鍔樺ù婊冪秺閺屻倗鍠婇崡鐐差潽闂?/span>
          <strong class="bme-cognition-metric__value">${_escHtml(
            String(strongVisibleNames.length),
          )}</strong>
        </div>
        <div class="bme-cognition-metric">
          <span class="bme-cognition-metric__label">闂傚倷娴囧畷鐢稿磻閻愬搫绀勭憸鐗堝笒绾惧鏌涢弴銊ュ箺闁哄棙绮撻弻娑㈠Ψ椤旂厧顫╃紓浣插亾?/span>
          <strong class="bme-cognition-metric__value">${_escHtml(
            String(new Set([...(ownerState.manualHiddenNodeIds || []), ...(ownerState.mistakenNodeIds || [])]).size),
          )}</strong>
        </div>
      </div>

      <div class="bme-cognition-line-list">
        <div class="bme-cognition-line">
          <span>闂傚倸鍊风粈渚€骞夐敍鍕殰闁冲搫鎳庣壕濠氭煕閺囥劌鐏犵紒?/span>
          <strong>${_escHtml(aliases.length ? aliases.join(" / ") : "闂?)}</strong>
        </div>
        <div class="bme-cognition-line">
          <span>闂備浇宕甸崰鎰垝鎼淬垺娅犳俊銈呮噹缁犱即鏌涘☉姗堟敾婵炲懐濞€閺岋絽螣濞嗘儳娈梺鍦嚀閻栧ジ寮婚埄鍐ㄧ窞濠电姴瀚搹搴ㄦ⒒?/span>
          <strong>${_escHtml(activeRegion || "闂?)}</strong>
        </div>
        <div class="bme-cognition-line">
          <span>闂傚倸鍊搁崐椋庢閿熺姴鍌ㄩ柛鎾楀啫鐏婂銈嗙墬缁秹寮冲鍫熺厵缂備降鍨归弸娑㈡煙閻熸壆鍩ｉ柡灞稿墲瀵板嫭绻濋崟顏囨闂?/span>
          <strong>${_escHtml(adjacentRegions.length ? adjacentRegions.join(" / ") : "闂?)}</strong>
        </div>
        <div class="bme-cognition-line">
          <span>闂傚倸鍊风粈渚€骞栭锔藉亱闁告劦鍠栫壕濠氭煙閹规劦鍤欑紒鐙欏洦鐓冮柛婵嗗閳ь剚鎮傞幃姗€鏁傞悾宀€顔曢梺鍦帛鐢宕戦妷褉鍋?/span>
          <strong>${_escHtml(
            ownerState.updatedAt ? _formatTaskProfileTime(new Date(ownerState.updatedAt).toISOString()) : "闂傚倸鍊风粈渚€骞栭鈶芥稑螖閸涱厾锛欓梺鑽ゅ枑鐎?,
          )}</strong>
        </div>
      </div>

      <div class="bme-cognition-chip-group">
        <div class="bme-cognition-chip-group__label">闂備浇顕х€涒晠顢欓弽顓炵獥闁哄稁鍘肩粻瑙勩亜閹扳晛鍔樺ù婊冪秺閺屻倗鍠婇崡鐐差潽闂佸摜濮村Λ妤呮箒闂佹寧绻傞悧濠囁夋径鎰嚉闁跨喓濮甸埛?/div>
        <div class="bme-cognition-chip-wrap">
          ${
            strongVisibleNames.length
              ? strongVisibleNames
                  .map((name) => `<span class="bme-cognition-chip">${_escHtml(name)}</span>`)
                  .join("")
              : '<span class="bme-cognition-chip is-empty">闂傚倸鍊风粈渚€骞栭鈶芥稑螖閸涱厾锛欓梺鑽ゅ枑鐎?/span>'
          }
        </div>
      </div>

      <div class="bme-cognition-chip-group">
        <div class="bme-cognition-chip-group__label">闂傚倷娴囧畷鐢稿磻閻愬搫绀勭憸鐗堝笒绾惧鏌涢弴銊ュ箺闁哄棙绮撻弻娑㈠Ψ椤旂厧顫╃紓浣插亾闁糕剝绋掗悡娆愩亜閺嶃劎鈯曠紒鑸电叀閹藉爼鏁撻悩鏂ユ嫼?/div>
        <div class="bme-cognition-chip-wrap">
          ${
            suppressedNames.length
              ? suppressedNames
                  .map((name) => `<span class="bme-cognition-chip is-muted">${_escHtml(name)}</span>`)
                  .join("")
              : '<span class="bme-cognition-chip is-empty">闂傚倸鍊风粈渚€骞栭鈶芥稑螖閸涱厾锛欓梺鑽ゅ枑鐎?/span>'
          }
        </div>
      </div>

      <div class="bme-cognition-node-override">
        <div class="bme-cognition-node-override__title">闂傚倷娴囬褍霉閻戣棄鏋侀柟闂寸缁犵娀鏌熼幆褍顣崇紒鈧繝鍥ㄥ€甸柨婵嗛閺嬫稓绱掗埀顒勫醇閳垛晛浜炬鐐茬仢閸旀碍銇勯敂璇蹭喊鐎规洘鍨块獮姗€寮堕幋鐘电嵁濠电姰鍨煎▔娑欘殽閹间胶宓侀柍褜鍓熷缁樻媴閸濆嫬浠橀梺鍦拡閸嬪﹤鐣烽幇顓犵瘈婵﹩鍓涢敍娑㈡⒑閹稿海绠撴い锔诲灣婢规洜绱掑Ο璇插伎濠殿喗顨呭Λ妤呯嵁閺嶃劊浜滈柕鍫濆缁愭棃鏌＄仦鍓ф创鐎殿噮鍓涢幏鐘诲箵閹烘繃缍傚┑锛勫亼閸婃劙寮查埡鍛；濠电姴娲ょ粻?/div>
        <div class="bme-config-help">
          ${
            selectedNode
              ? `闂備浇宕甸崰鎰垝鎼淬垺娅犳俊銈呮噹缁犱即鏌涘☉姗堟敾婵炲懐濞€閺岋絽螣閼测晛绗￠梺鎼炲€曠粔褰掑蓟濞戞矮娌柛鎾楀懐鍘愬┑鐐差嚟婵參宕归崼鏇炶摕?{_escHtml(selectedNodeLabel)} 闂?闂傚倷娴囧畷鍨叏閺夋嚚娲閵堝懐锛熼梺鍦檸閸ｎ垳绱為弽銊ょ箚闁靛牆鎳忛崳娲煕閵堝懐鐒搁柡宀€鍠撶槐鎺懳熼搹璇″剬缂傚倷绀侀ˇ顖炲Χ閹间礁钃熸繛鎴欏灩缁犺崵鈧娲栧▔锕傚Χ閸涱亝鏂€濡炪倖妫佹慨銈夊磹閹邦収娈介柣鎰ㄦ櫅娴滄儳鈹戦悙瀛樺鞍闁煎綊绠栭弫鍐晜閸撗呭箵?{_escHtml(selectedNodeState)}`
              : "闂傚倸鍊烽懗鍫曗€﹂崼銏″床闁规壆澧楅崑瀣煕閳╁喚娈ｉ柤鐗堝閵囧嫯绠涢幘璺侯暫闂佺粯鍔曢敃顏堝蓟閻旂儤鍠嗛柛鏇ㄥ亜椤秹姊哄Ч鍥у闁搞劌娼″濠氭偄鐞涒€充壕婵炴垶鐟悞钘夘熆瑜戝▍鏇㈠Φ閸曨垰妫橀柟绋挎捣閳规稓绱撴担鍝勑ｉ柣鈺婂灠閻ｇ兘宕￠悙宥嗘閸┾偓妞ゆ帒瀚崐鑸电箾閸℃ɑ灏伴柛瀣У缁绘盯骞嬮悙闈涒吂婵犵鍓濆浠嬪蓟閵堝鍨傛い鎰╁灮娴煎矂姊虹拠鈥虫灍闁荤啿鏅犲濠氬川椤撴稒顫嶅┑顔斤耿濡法妲愬Ο琛℃斀闁绘劖娼欓悘锕傛煙鐏忔牗娅嗙紒鍌氱Ч閺佹劙宕遍弴鐘电暰婵＄偑鍊栭幐鍫曞垂濞差亜纾归柣鎴ｅГ閻撶喓鎲稿澶婄婵犲﹤鎳愰惌鍡楊熆閼搁潧濮堥柣鎾存礋閺岀喖鏌囬敃鈧晶鎵偓娑欑箓閳规垿鎮欓幓鎺旈獓闂佺粯顨堟慨鎾敋閿濆閱囬柡鍥╁€ｉ妸鈺傜厪濠㈣泛鐗嗛埀顒侇殕閵囨瑩骞庨懞銉㈡嫼閻熸粎澧楃敮妤€鈽夎閵囧嫰骞嬪┑鍥ф闂侀€涚┒閸旀垿宕洪敓鐘茬闁宠桨鐒﹀В鍥⒒娴ｈ櫣銆婇柛鎾寸箞閹兘鏁傞幆褜妫滄繛瀵稿帶閻°劑鎮?
          }
        </div>
        <div class="bme-cognition-node-actions">
          <button
            class="bme-config-secondary-btn"
            type="button"
            data-bme-cognition-node-action="known"
            ${!selectedNode || writeBlocked ? "disabled" : ""}
          >
            闂備浇顕х€涒晠顢欓弽顓炵獥闁哄稁鍘肩粻瑙勩亜閹板墎鐣遍柡鍕╁劜娣囧﹪濡堕崒姘婵＄偑鍊栭弻銊ф崲濮椻偓楠炲﹪鎮╁ú缁樻櫌闂佺鏈懝鍓х磼?
          </button>
          <button
            class="bme-config-secondary-btn"
            type="button"
            data-bme-cognition-node-action="hidden"
            ${!selectedNode || writeBlocked ? "disabled" : ""}
          >
            闂備浇顕х€涒晠顢欓弽顓炵獥闁哄稁鍘肩粻瑙勩亜閹板墎鐣遍柡鍕╁劜娣囧﹪濡堕崨顔兼闂佹娊鏀卞ú鐔煎蓟閻斿吋鐒介柨鏇楀亾闁诲繆鍓濋妵?
          </button>
          <button
            class="bme-config-secondary-btn"
            type="button"
            data-bme-cognition-node-action="mistaken"
            ${!selectedNode || writeBlocked ? "disabled" : ""}
          >
            闂傚倸鍊风粈渚€骞栭銈囩煋闁哄鍤氬ú顏勭厸闁告粈鐒﹂弲鈺呮⒑閹肩偛鍔楅柡鍛矌閳ь剚纰嶇喊宥夊Φ閸曨垰鍐€闁靛ě鍕拡?
          </button>
          <button
            class="bme-config-secondary-btn"
            type="button"
            data-bme-cognition-node-action="clear"
            ${!selectedNode || writeBlocked ? "disabled" : ""}
          >
            婵犵數濮烽弫鎼佸磻閻愬搫绠伴柟闂寸缁犵姵淇婇婵勨偓鈧柡瀣Ч楠炴牗娼忛崜褏蓱闂佸摜鍠愬浠嬪蓟濞戙垹鐒洪柛鎰典簼閸ｎ厾绱?
          </button>
        </div>
      </div>
    </div>
  `;
}

function _refreshCognitionDashboard(
  graph,
  loadInfo = _getGraphPersistenceSnapshot(),
) {
  const canRenderGraph =
    Boolean(graph) &&
    (_canRenderGraphData(loadInfo) || loadInfo.loadState === "empty-confirmed");
  const manualRegionInput = document.getElementById("bme-cognition-manual-region");
  const adjacencyInput = document.getElementById("bme-cognition-adjacency-input");
  if (manualRegionInput) manualRegionInput.disabled = !canRenderGraph || _isGraphWriteBlocked(loadInfo);
  if (adjacencyInput) adjacencyInput.disabled = !canRenderGraph || _isGraphWriteBlocked(loadInfo);

  if (!canRenderGraph) {
    _setText("bme-cognition-active-owner", "闂?);
    _setText("bme-cognition-active-region", _getGraphLoadLabel(loadInfo.loadState));
    _setText("bme-cognition-adjacent-regions", "闂?);
    _setText("bme-cognition-owner-count", "闂?);
    _renderStatefulListPlaceholder(
      document.getElementById("bme-cognition-owner-list"),
      _getGraphLoadLabel(loadInfo.loadState),
    );
    const detailEl = document.getElementById("bme-cognition-detail");
    if (detailEl) {
      detailEl.innerHTML = `
        <div class="bme-cognition-empty">${_escHtml(_getGraphLoadLabel(loadInfo.loadState))}</div>
      `;
    }
    _setInputValueIfIdle("bme-cognition-manual-region", "");
    _setInputValueIfIdle("bme-cognition-adjacency-input", "");
    return;
  }

  const historyState = graph?.historyState || {};
  const regionState = graph?.regionState || {};
  const {
    owners,
    activeOwnerKey,
    activeOwnerLabels,
    selectedOwner,
    activeOwner,
  } = _getCurrentCognitionOwnerSummary(graph);
  const collisionIndex = _buildOwnerCollisionIndex(owners);
  const activeRegion = String(
    historyState.activeRegion ||
      historyState.lastExtractedRegion ||
      regionState.manualActiveRegion ||
      "",
  ).trim();
  const activeRegionLabel = activeRegion
    ? `${activeRegion}${
        historyState.activeRegionSource ? ` 闂?${historyState.activeRegionSource}` : ""
      }`
    : "闂?;
  const adjacentRegions = Array.isArray(regionState?.adjacencyMap?.[activeRegion]?.adjacent)
    ? regionState.adjacencyMap[activeRegion].adjacent
    : [];

  _setText(
    "bme-cognition-active-owner",
    activeOwnerLabels.length > 0
      ? activeOwnerLabels.join(" / ")
      : activeOwner
        ? _getOwnerDisplayInfo(activeOwner, collisionIndex).title
        : activeOwnerKey || "闂?,
  );
  _setText("bme-cognition-active-region", activeRegionLabel || "闂?);
  _setText(
    "bme-cognition-adjacent-regions",
    adjacentRegions.length > 0 ? adjacentRegions.join(" / ") : "闂?,
  );
  _setText("bme-cognition-owner-count", owners.length);
  // Cognition view workspace refresh (if visible)
  if (currentGraphView === "cognition") {
    _refreshCognitionWorkspace();
  }
}

function _refreshAiMonitorDashboard() {
  const settings = _getSettings?.() || {};
  if (settings.enableAiMonitor !== true) {
    _renderMiniRecentList(
      "bme-ai-monitor-list",
      [],
      "濠电姷鏁搁崑娑㈩敋椤撶喐鍙忓Δ锝呭枤閺佸鎲告惔銊ョ疄闁靛ň鏅滈崑鍕煕韫囨洖甯堕柛鎿冨櫍濮婅櫣娑甸崨顔兼锭缂傚倸绉村Λ妤呪€﹂崶顒€绠虫俊銈勮兌閸橀亶姊洪幐搴ｇ畵闁哥噥鍋呮穱濠冪附閸涘﹦鍘遍梺瑙勬儗閸ㄥ磭寮ч埀顒勬倵鐟欏嫭绀冩い銊ワ躬閻涱喗鎯旈妸锕€娈熼梺闈涱樈閸ㄥ啿顔?,
    );
    return;
  }

  const runtimeDebug = _getRuntimeDebugSnapshot?.() || {};
  const timeline = Array.isArray(runtimeDebug?.runtimeDebug?.taskTimeline)
    ? runtimeDebug.runtimeDebug.taskTimeline
    : [];
  _renderMiniRecentList(
    "bme-ai-monitor-list",
    timeline
      .slice(-6)
      .reverse()
      .map((entry) => {
        const route =
          _getMonitorRouteLabel(entry?.route) ||
          _getMonitorRouteLabel(entry?.llmConfigSourceLabel) ||
          "";
        const model = String(entry?.model || "").trim();
        const durationText =
          Number.isFinite(Number(entry?.durationMs)) && Number(entry.durationMs) > 0
            ? `${Math.round(Number(entry.durationMs))}ms`
            : "";
        return [
          _getMonitorTaskTypeLabel(entry?.taskType),
          _getMonitorStatusLabel(entry?.status),
          route || model ? `${route || model}` : "",
          durationText,
        ]
          .filter(Boolean)
          .join(" 闂?");
      }),
    "闂傚倸鍊风粈渚€骞栭鈶芥稑螖閸涱厾锛欓梺鑽ゅ枑鐎氬牆鈽夐姀鐘栄囨煕閳╁啰鎳愭繛鏉戝閺岋綁鎮╅崣澶婎槱閻熸粍婢橀崯鎾晲閻愬搫围闁糕剝鐟ч鏇犵磽閸屾氨澧㈠┑顔惧厴瀹曟繂顓兼径瀣幍?,
  );
}

function _renderRecentList(elementId, items) {
  const listEl = document.getElementById(elementId);
  if (!listEl) return;

  if (!items.length) {
    const li = document.createElement("li");
    li.className = "bme-recent-item";
    const text = document.createElement("div");
    text.className = "bme-recent-text";
    text.style.color = "var(--bme-on-surface-dim)";
    text.textContent = "闂傚倸鍊风粈渚€骞栭鈶芥稑螖閸涱厾锛欓梺鑽ゅ枑鐎氬牆鈽夐姀鐘栄冾熆鐠虹尨鏀婚柣搴墴濮婅櫣绱掑鍡樼暥闂佺粯顨呭Λ娑氬垝?;
    li.appendChild(text);
    listEl.replaceChildren(li);
    return;
  }

  const fragment = document.createDocumentFragment();
  items.forEach((item) => {
    const secondary = item.meta || item.time || "";
    const li = document.createElement("li");
    li.className = "bme-recent-item";

    const badge = document.createElement("span");
    badge.className = `bme-type-badge ${_safeCssToken(item.type)}`;
    badge.textContent = _typeLabel(item.type);
    li.appendChild(badge);

    const content = document.createElement("div");
    const title = document.createElement("div");
    title.className = "bme-recent-text";
    title.textContent = item.name || "闂?;
    const meta = document.createElement("div");
    meta.className = "bme-recent-meta";
    meta.textContent = secondary;
    content.append(title, meta);
    li.appendChild(content);

    fragment.appendChild(li);
  });
  listEl.replaceChildren(fragment);
}

// ==================== 闂傚倷娴囧畷鍨叏閹惰姤鍊块柨鏇楀亾妞ゎ厼鐏濊灒闁稿繒鍘ф惔濠囨⒑缁嬫寧婀版い鏇樺灮濞戠敻宕ㄩ婊勬緫婵犳鍠楅敋闁告艾顑囩槐鐐茬暆閸曨兘鎷?====================

function _refreshMemoryBrowser() {
  const graph = _getGraph?.();
  const loadInfo = _getGraphPersistenceSnapshot();
  if (!graph) return;

  const searchInput = document.getElementById("bme-memory-search");
  const regionInput = document.getElementById("bme-memory-region-filter");
  const filterSelect = document.getElementById("bme-memory-filter");
  const listEl = document.getElementById("bme-memory-list");
  if (!listEl) return;

  const canRenderGraph = _canRenderGraphData(loadInfo);
  if (searchInput) searchInput.disabled = !canRenderGraph;
  if (regionInput) regionInput.disabled = !canRenderGraph;
  if (filterSelect) filterSelect.disabled = !canRenderGraph;

  if (!canRenderGraph && loadInfo.loadState !== "empty-confirmed") {
    _renderStatefulListPlaceholder(listEl, _getGraphLoadLabel(loadInfo.loadState));
    return;
  }

  const query = String(searchInput?.value || "")
    .trim()
    .toLowerCase();
  const regionQuery = String(regionInput?.value || "")
    .trim()
    .toLowerCase();
  const filter = filterSelect?.value || "all";

  let nodes = graph.nodes.filter((node) => !node.archived);
  if (filter !== "all") {
    nodes = nodes.filter((node) => _matchesMemoryFilter(node, filter));
  }
  if (query) {
    nodes = nodes.filter((node) => {
      const name = getNodeDisplayName(node).toLowerCase();
      const text = JSON.stringify(node.fields || {}).toLowerCase();
      return name.includes(query) || text.includes(query);
    });
  }
  if (regionQuery) {
    nodes = nodes.filter((node) => {
      const scope = normalizeMemoryScope(node.scope);
      const regionText = [
        scope.regionPrimary,
        ...(scope.regionPath || []),
        ...(scope.regionSecondary || []),
      ]
        .join(" ")
        .toLowerCase();
      return regionText.includes(regionQuery);
    });
  }

  nodes.sort((a, b) => {
    const importanceDiff = (b.importance || 5) - (a.importance || 5);
    if (importanceDiff !== 0) return importanceDiff;
    return (b.seqRange?.[1] ?? b.seq ?? 0) - (a.seqRange?.[1] ?? a.seq ?? 0);
  });

  if (!nodes.length && loadInfo.loadState === "empty-confirmed") {
    _renderStatefulListPlaceholder(listEl, "闂備浇宕甸崰鎰垝鎼淬垺娅犳俊銈呮噹缁犱即鏌涘☉姗堟敾婵炲懐濞€閺岋絽螣閼测晛绗￠梺鎼炲€曢崐鎼佸煘閹达附鍋愰柟缁樺坊閸嬫捇鎳滈悽娈挎锤濡炪倖鐗滈崑娑氱棯瑜旈弻宥夊传閸曨亞瑙﹂梺纭呮彧闂勫嫰宕曟径鎰厱婵炴垶鐟︾紞鎴︽倵濮橆剦妲告い顓℃硶閹瑰嫰鎮€涙ɑ鏆扮紓鍌欑閸婃悂鎮ч幘璇茬畺?);
    return;
  }

  const fragment = document.createDocumentFragment();
  nodes.slice(0, 100).forEach((node) => {
    const name = getNodeDisplayName(node);
    const snippetText = _getNodeSnippet(node);
    const li = document.createElement("li");
    li.className = "bme-memory-item";
    li.dataset.nodeId = String(node.id || "");

    const card = document.createElement("div");
    card.className = "bme-memory-card";

    const head = document.createElement("div");
    head.className = "bme-memory-card-head";

    const badge = document.createElement("span");
    badge.className = `bme-type-badge ${_safeCssToken(node.type)}`;
    badge.textContent = _typeLabel(node.type);

    const scopeChip = document.createElement("span");
    scopeChip.className = "bme-memory-scope-chip";
    scopeChip.textContent = buildScopeBadgeText(node.scope);

    head.append(badge, scopeChip);

    const titleEl = document.createElement("div");
    titleEl.className = "bme-memory-name";
    titleEl.textContent = name;

    const snippetEl = document.createElement("div");
    snippetEl.className = "bme-memory-content";
    snippetEl.textContent = snippetText;

    const foot = document.createElement("div");
    foot.className = "bme-memory-foot";

    const stats = document.createElement("div");
    stats.className = "bme-memory-stats";

    const impSpan = document.createElement("span");
    impSpan.className = "bme-memory-stat-pill";
    impSpan.textContent = `闂傚倸鍊搁崐鐑芥倿閿曚降浜归柛鎰典簽閻捇鏌ｉ幋婵愭綗闁逞屽墮閹虫﹢寮崒鐐村殟闁靛鍎辨俊?${_formatMemoryMetricNumber(node.importance, {
      fallback: 5,
      maxFrac: 2,
    })}`;

    const accSpan = document.createElement("span");
    accSpan.className = "bme-memory-stat-pill";
    accSpan.textContent = `闂傚倷娴囧畷鍨叏瀹曞洨鐭嗗ù锝呭閻掍粙鏌嶉妷锔剧獮?${_formatMemoryInt(node.accessCount, 0)}`;

    const seqSpan = document.createElement("span");
    seqSpan.className = "bme-memory-stat-pill";
    seqSpan.textContent = `闂傚倷鑳堕幊鎾诲触鐎ｎ亶鐒芥繛鍡樺灦瀹曟煡鏌熼悧鍫熺凡闁?${_formatMemoryInt(
      node.seqRange?.[1] ?? node.seq,
      0,
    )}`;

    stats.append(impSpan, accSpan, seqSpan);
    foot.appendChild(stats);

    const regionMeta = _buildScopeMetaText(node);
    if (regionMeta) {
      const regionEl = document.createElement("div");
      regionEl.className = "bme-memory-region";
      regionEl.textContent = regionMeta;
      foot.appendChild(regionEl);
    }

    card.append(head, titleEl, snippetEl, foot);
    li.appendChild(card);
    fragment.appendChild(li);
  });
  listEl.replaceChildren(fragment);

  listEl.querySelectorAll(".bme-memory-item").forEach((el) => {
    el.addEventListener("click", () => {
      const nodeId = el.dataset.nodeId;
      graphRenderer?.highlightNode(nodeId);
      mobileGraphRenderer?.highlightNode(nodeId);
      const node = graph.nodes.find((candidate) => candidate.id === nodeId);
      if (node) _showNodeDetail(node);
    });
  });

  if (searchInput && !searchInput._bmeBound) {
    let timer = null;
    searchInput.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(() => _refreshMemoryBrowser(), 200);
    });
    regionInput?.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(() => _refreshMemoryBrowser(), 200);
    });
    filterSelect?.addEventListener("change", () => _refreshMemoryBrowser());
    searchInput._bmeBound = true;
  }
}

// ==================== 婵犵數濮烽弫鎼佸磻濞戔懞鍥敇閵忕姷顦悗鍏夊亾闁告洦鍋嗛悡鎴︽⒑缁洖澧查柨鏇ㄥ亞濡叉劙鏁愭径瀣幈闂佸搫娲㈤崝灞解枍濡崵绠?====================

async function _refreshInjectionPreview() {
  const container = document.getElementById("bme-injection-content");
  const tokenEl = document.getElementById("bme-injection-tokens");
  if (!container) return;

  const injection = String(_getLastInjection?.() || "").trim();
  if (!injection) {
    const empty = document.createElement("div");
    empty.className = "bme-injection-preview";
    empty.style.color = "var(--bme-on-surface-dim)";
    empty.textContent = "闂傚倸鍊风粈渚€骞栭鈶芥稑螖閸涱厾锛欓梺鑽ゅ枑鐎氬牆鈽夐姀鐘栄囨煕濞戝彉绨奸柣蹇撳暣濮婃椽妫冨☉杈╁姼闂佺楠稿畷顒勵敋閿濆绠柤鎭掑劤閸橀亶姊鸿ぐ鎺戜喊闁告挻宀稿畷宕囨喆閸曗晙绨婚梺鍝勫暊閸嬫捇鏌涢弮鈧悷锔界┍婵犲洤绠绘い鏃囧亹閿涙粌鈹戦鏂や緵闁告挻鐟ラ锝呂旈崨顔惧幗闁硅壈鎻徊楣冨吹閳ь剟姊洪崫鍕⒈闁告挾鍠庨悾鐑芥偡闁附鍍靛銈嗘尵婵參寮搁弽顓熲拺闂侇偆鍋涢懟顖涙櫠椤曗偓閺屽秶鎷犻弻銉ュ及闂佹悶鍔戠粻鏍х暦濮椻偓楠炴捇骞掗弮鈧鎴︽⒒閸屾瑧鍔嶉柟顔肩埣瀹曟洟骞庨挊澶岋紱闂佺粯鍔曢幖顐﹀垂閸岀偞鐓忓┑鐐茬仢閸斿瓨绻涢梻鏉戝祮闁哄被鍔岄埞鎴﹀幢濡儤顏ら梻浣虹《閺呮粓銆冩繝鍥ц摕闁挎繂顦～鍛存煏韫囨洖校闁诲酣绠栧娲箹閻愭彃顬夐悗鍏夊亾缂佸娉曢弳锕傛煏婢舵盯妾柛搴ｅ枛閺屽秹濡烽妸锔惧涧濠电偛鎳庨崯鏉戭潖濞差亜浼犻柛鏇ㄥ櫘濞煎爼姊虹粙鍧楊€楅柛鐔锋健閺佸啴濮€閵堝懎绐涢梺鍝勵槹閸?;
    container.replaceChildren(empty);
    if (tokenEl) tokenEl.textContent = "";
    return;
  }

  try {
    const { estimateTokens } = await import("../retrieval/injector.js");
    const totalTokens = estimateTokens(injection);
    const preview = _buildInjectionPreviewNode(injection);
    container.replaceChildren(preview);
    if (tokenEl) tokenEl.textContent = `闂?${totalTokens} tokens`;
  } catch (error) {
    const failure = document.createElement("div");
    failure.className = "bme-injection-preview";
    failure.style.color = "var(--bme-accent3)";
    failure.textContent = `濠电姷顣藉Σ鍛村磻閸涱収鐔嗘俊顖氱毞閸嬫挸顫濋悡搴ｄ桓闂佹寧绻勯崑娑㈩敇閸忕厧绶為悗锝庝簷缂傛捇姊绘担铏瑰笡婵﹤顭烽垾锕傚醇閵夛箑鈧爼鏌涢妷鎴濈灱閸炵敻姊虹拠鈥崇仭濠㈢懓妫涢懞閬嶅锤濡や礁浠? ${error.message}`;
    container.replaceChildren(failure);
    if (tokenEl) tokenEl.textContent = "";
  }
}

function _buildInjectionPreviewNode(injectionText = "") {
  const parsed = _parseInjectionPreview(String(injectionText || ""));
  if (!parsed.sections.length) {
    const preview = document.createElement("div");
    preview.className = "bme-injection-preview";
    preview.textContent = injectionText;
    return preview;
  }

  const root = document.createElement("div");
  root.className = "bme-injection-rich";

  const hint = document.createElement("div");
  hint.className = "bme-injection-rich__hint";
  hint.textContent = "闂傚倷绀侀幖顐λ囬锕€鐤炬繝濠傜墛閸嬶繝鏌嶉崫鍕櫣闂傚偆鍨堕弻锝夊箣閿濆棭妫勯梺鍛婄懃閿曘儵濡甸崟顖氬唨闁靛ě鍛帓婵犵數鍋涢ˇ顓㈠垂娴犲钃熼柨娑樺閸嬫捇鏁愭惔婵堢泿濡炪倕绻嗛弲鐘诲箖濡ゅ懏顥堟繛鎴烆焽妤犲洭姊洪幐搴ｂ姇闁告梹鐟ラ悾鐑芥偄绾拌鲸鏅梺鍛婁緱閸犳氨绮旀ィ鍐┾拻濞达絿鎳撻婊呯磼鐎ｎ偄鐏︾紒杞扮矙瀵噣宕掑鍛幇闂備胶鍘ч幗婊堝极閹间降鈧懘寮婚妷銉ь啇濠电儑缍嗛崜娆愪繆閼恒儯浜滄い鎰╁焺濡偓闂佽鍠栫紞濠傜暦閸洘鏅滈柛娆嶅劥椤╊偆绱撻崒娆愮グ缂侇喚鍋撶粋宥夘敆閸曨偆鍔﹀銈嗗坊閸嬫挻绻濋埀顒勬焼瀹ュ懐锛涢梺闈涚墕閹峰鎮楅懜鐐逛簻闁哄稁鍋勬禒婊堟煟椤撶噥娈滈柡宀€鍠撻埀顒傛暩椤牆鏆╅梻浣稿悑閻℃洟宕洪弽銊р攳濠电姴娴傞弫宥嗕繆閻愰鍤欏ù婊冨⒔閳ь剝顫夊ú鏍洪悩璇茬；闁瑰墽绮崐濠氭煠閹帒鍔氶柛鎿冨弮濮婃椽宕ㄦ繝鍐槱婵炲瓨绮庨崑銈夊箚鐏炶В鏀介悗锝庡亞閸樻悂姊洪崨濠冪婵炰匠鍥ㄥ€堕柣妯肩帛閸嬨劍銇勯弽鐢靛埌濞存粍绻堥弻鐔哥瑹閸喖顬嬮梺閫炲苯澧剧紓宥呮瀹曟垿宕ㄩ弶鎴炶緢闂佸壊鍋侀崕鏌ユ偂閺囥垻鍙撻柛銉戝苯鍓伴梺鍛婃⒐缁捇寮婚敍鍕ㄥ亾閿濆簼绨婚柡鍡悼閳ь剚顔栭崰姘跺极婵犳哎鈧線寮介鐔哄弳濡炪倖鐗楅惌顔界珶?;
  root.appendChild(hint);

  for (const section of parsed.sections) {
    const card = document.createElement("section");
    card.className = `bme-injection-card ${_getInjectionSectionFlavor(section.title)}`;

    const title = document.createElement("div");
    title.className = "bme-injection-card__title";
    title.textContent = section.title;
    card.appendChild(title);

    if (section.note) {
      const note = document.createElement("div");
      note.className = "bme-injection-card__note";
      note.textContent = section.note;
      card.appendChild(note);
    }

    for (const block of section.blocks) {
      if (block.type === "table") {
        card.appendChild(_buildInjectionTableNode(block));
      } else if (block.type === "text" && block.text) {
        const text = document.createElement("div");
        text.className = "bme-injection-card__text";
        text.textContent = block.text;
        card.appendChild(text);
      }
    }

    root.appendChild(card);
  }

  return root;
}

function _parseInjectionPreview(injectionText = "") {
  const lines = String(injectionText || "").replace(/\r/g, "").split("\n");
  const sections = [];
  let index = 0;
  let currentSection = null;

  function ensureSection(title = "Memory") {
    if (!currentSection) {
      currentSection = {
        title,
        note: "",
        blocks: [],
      };
      sections.push(currentSection);
    }
    return currentSection;
  }

  while (index < lines.length) {
    const rawLine = lines[index] ?? "";
    const line = rawLine.trim();

    if (!line) {
      index += 1;
      continue;
    }

    const sectionMatch = line.match(/^\[(Memory\s*-\s*.+)]$/i);
    if (sectionMatch) {
      currentSection = {
        title: sectionMatch[1],
        note: "",
        blocks: [],
      };
      sections.push(currentSection);
      index += 1;

      const noteCandidate = (lines[index] ?? "").trim();
      if (
        noteCandidate &&
        !noteCandidate.startsWith("[") &&
        !noteCandidate.endsWith(":") &&
        !noteCandidate.startsWith("|") &&
        !noteCandidate.startsWith("## ")
      ) {
        currentSection.note = noteCandidate;
        index += 1;
      }
      continue;
    }

    const section = ensureSection();

    if (line.endsWith(":") && String(lines[index + 1] || "").trim().startsWith("|")) {
      const tableName = line.slice(0, -1).trim();
      const tableLines = [];
      index += 1;
      while (index < lines.length) {
        const tableLine = String(lines[index] || "");
        if (!tableLine.trim().startsWith("|")) {
          break;
        }
        tableLines.push(tableLine.trim());
        index += 1;
      }
      const parsedTable = _parseInjectionTable(tableName, tableLines);
      if (parsedTable) {
        section.blocks.push(parsedTable);
      }
      continue;
    }

    const textLines = [];
    while (index < lines.length) {
      const candidate = String(lines[index] || "").trim();
      if (!candidate) {
        index += 1;
        if (textLines.length > 0) {
          break;
        }
        continue;
      }
      if (
        /^\[(Memory\s*-\s*.+)]$/i.test(candidate) ||
        (candidate.endsWith(":") && String(lines[index + 1] || "").trim().startsWith("|"))
      ) {
        break;
      }
      textLines.push(candidate);
      index += 1;
    }
    if (textLines.length > 0) {
      section.blocks.push({
        type: "text",
        text: textLines.join("\n"),
      });
    }
  }

  return { sections };
}

function _parseInjectionTable(tableName, tableLines = []) {
  if (!Array.isArray(tableLines) || tableLines.length < 2) {
    return null;
  }

  const headerCells = _splitInjectionTableRow(tableLines[0]);
  if (!headerCells.length) {
    return null;
  }

  const rows = tableLines
    .slice(2)
    .map((row) => _splitInjectionTableRow(row))
    .filter((cells) => cells.length > 0);

  return {
    type: "table",
    name: tableName,
    headers: headerCells,
    rows,
  };
}

function _splitInjectionTableRow(row = "") {
  const text = String(row || "").trim();
  if (!text.startsWith("|")) {
    return [];
  }

  const inner = text.replace(/^\|/, "").replace(/\|$/, "");
  const cells = [];
  let current = "";
  let escaped = false;

  for (const ch of inner) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === "|") {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }

  cells.push(current.trim());
  return cells.map((cell) => cell.replace(/\\\|/g, "|").trim());
}

function _buildInjectionTableNode(table) {
  const wrap = document.createElement("div");
  wrap.className = "bme-injection-table-wrap";

  const name = document.createElement("div");
  name.className = "bme-injection-table-name";
  name.textContent = table.name;
  wrap.appendChild(name);

  const tableEl = document.createElement("table");
  tableEl.className = "bme-injection-table";

  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const header of table.headers) {
    const th = document.createElement("th");
    th.textContent = header;
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  tableEl.appendChild(thead);

  const tbody = document.createElement("tbody");
  for (const row of table.rows) {
    const tr = document.createElement("tr");
    const normalizedCells = table.headers.map((_, idx) => row[idx] ?? "");
    for (const cell of normalizedCells) {
      const td = document.createElement("td");
      td.textContent = cell;
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  tableEl.appendChild(tbody);
  wrap.appendChild(tableEl);
  return wrap;
}

function _getInjectionSectionFlavor(title = "") {
  const normalized = String(title || "").toLowerCase();
  if (normalized.includes("character pov")) return "character-pov";
  if (normalized.includes("user pov")) return "user-pov";
  if (normalized.includes("current region")) return "objective-current";
  if (normalized.includes("global")) return "objective-global";
  return "generic";
}

// ==================== 闂傚倸鍊烽悞锕傚箖閸洖纾块柟缁樺笧閺嗭附淇婇娆掝劅婵?====================

/** SillyTavern 闂傚倸鍊烽悞锕€顪冮崹顕呯劷闁秆勵殔缁€澶屸偓骞垮劚椤︻垶寮伴妷锔剧闁瑰瓨鐟ラ悘鈺呮煕濞嗗骏韬柡灞剧洴楠炴ê顪冮悙顒夋▊缂備緡鍠氶弫璇差潖濞差亜宸濆┑鐘叉噹椤ユ繄绱撴担鍓插剰閻庢凹鍠栧嵄闁归偊鍓﹂悗鍫曟煛閳ь剚绋婄粈?闂傚倸鍊烽悞锔锯偓绗涘懐鐭欓柟娆″眰鍔戦崺鈧い鎺戝€荤壕濂稿级閸稑濡跨紒鐘靛仱閺岀喖顢欓懡銈囩厯婵犵鍓濋幃鍌涗繆閸洖鐐婃い蹇撳濡喖姊婚崒娆戝妽闁诡喖鐖煎畷鏇㈠箵閹烘梹娈惧┑鈽嗗灟鐠€锕€顭囬埡鍛厪濠电偟鍋撳▍鍛磼閳ь剟宕卞☉娆戝幈闂佹枼鏅涢崰姘枔閺冨牊鈷掗柛娑卞櫙閼板潡鏌＄仦璇插闁宠棄顦埢搴㈡償濠靛棭鍔夊┑锛勫亼閸婃牕煤韫囨稑纾规繝闈涙－閸ゆ洖霉閻樺樊鍎忛柣鎰躬閺屻劑寮村鍐插帯濡炪倧缂氶崡鎶藉蓟閿濆鍋勯柛婵勫劜閸ｎ參鏌ｉ姀鈺佺仯闁哥姵鍔楃划鈺呮偄閸濄儳鐦堥梺鎼炲劘閸斿矂宕滈銏♀拺闁告稑锕ユ径鍕煕濡湱鐭欑€殿喖鐤囩粻娑樷槈濞嗘垵骞?POV 闂備浇顕х€涒晠顢欓弽顓炵獥闁哄稁鍘肩粻瑙勩亜閹板墎鐣遍柡鍕╁劜娣囧﹪濡堕崨顓т淮婵炲瓨绮岀紞濠囧蓟閻斿吋鍊绘俊顖滃劦閹峰綊姊洪崫鍕棞缂佺粯锕㈠濠氭偄閻撳海楠囬梺鐟扮摠缁诲啩绨洪梻?*/
function _hostUserPovAliasHintsForGraph() {
  return getHostUserAliasHints();
}

function _refreshGraph() {
  const graph = _getGraph?.();
  if (!graph) return;
  const hints = { userPovAliases: _hostUserPovAliasHintsForGraph() };
  graphRenderer?.loadGraph(graph, hints);
  mobileGraphRenderer?.loadGraph(graph, hints);
  if (currentGraphView === "cognition") {
    _refreshCognitionWorkspace();
  } else if (currentGraphView === "summary") {
    _refreshSummaryWorkspace();
  }
}

function _buildLegend() {
  const legendEl = document.getElementById("bme-graph-legend");
  if (!legendEl) return;

  const settings = _getSettings?.() || {};
  const colors = getNodeColors(settings.panelTheme || "crimson");
  const scopeColors = {
    objective: "#57c7ff",
    characterPov: "#ffb347",
    userPov: "#7dff9b",
  };
  const layers = [
    { key: "objective", label: "闂傚倷娴囬褎顨ラ崫銉т笉鐎广儱顦崹鍌氣攽閸岀偞浜ょ紓宥嗙墵閺屾盯濡烽姀鈩冪彃濠? },
    { key: "characterPov", label: "闂傚倷娴囧畷鐢稿窗閹扮増鍋￠柨鏃傚亾閺嗘粓鏌ｉ弬鎸庢喐闁?POV" },
    { key: "userPov", label: "闂傚倸鍊烽悞锕€顪冮崹顕呯劷闁秆勵殔缁€澶屸偓骞垮劚椤︻垶寮?POV" },
  ];
  const types = [
    { key: "character", label: "闂傚倷娴囧畷鐢稿窗閹扮増鍋￠柨鏃傚亾閺嗘粓鏌ｉ弬鎸庢喐闁? },
    { key: "event", label: "濠电姷鏁搁崑娑㈡偤閵娧冨灊鐎光偓閸曞灚鏅為梺鍛婃处閸嬧偓闁? },
    { key: "location", label: "闂傚倸鍊风欢姘焽婵犳碍鈷旈柛鏇ㄥ墰閻濆爼鏌涢埄鍐槈缁? },
    { key: "thread", label: "濠电姷鏁搁崑鐐哄垂閸洖绠插ù锝呮憸閺嗭箓鏌ｉ姀銏╃劸闁? },
    { key: "rule", label: "闂傚倷娴囧畷鐢稿窗閹扮増鍋￠柕澹偓閸嬫挸顫濋悡搴♀拫閻? },
    { key: "synopsis", label: "婵犵數濮甸鏍窗濡ゅ啯鏆滈柟鐑橆殔绾剧懓霉閻樺樊鍎嶉柍? },
    { key: "reflection", label: "闂傚倸鍊风粈渚€骞夐敓鐘冲仭闁靛／鍛厠闂佹眹鍨婚…鍫ユ倿? },
    { key: "pov_memory", label: "濠电姷鏁搁崑鐐哄垂閸洖绠伴悹鍥у棘閿濆绠虫俊銈咁儑缁嬪繘姊洪幖鐐插姉闁哄懏绮嶉崚濠冪附閸涘﹦鍘告繝銏ｆ硾鐎涒晝娑甸崜浣虹＜? },
  ];

  const fragment = document.createDocumentFragment();
  layers.forEach((type) => {
    const item = document.createElement("span");
    item.className = "bme-legend-item";
    const dot = document.createElement("span");
    dot.className = "bme-legend-dot";
    dot.style.background = scopeColors[type.key] || "";
    item.appendChild(dot);
    item.append(document.createTextNode(type.label));
    fragment.appendChild(item);
  });
  types.forEach((type) => {
    const item = document.createElement("span");
    item.className = "bme-legend-item";
    const dot = document.createElement("span");
    dot.className = "bme-legend-dot";
    dot.style.background = colors[type.key] || "";
    item.appendChild(dot);
    item.append(document.createTextNode(type.label));
    fragment.appendChild(item);
  });
  legendEl.replaceChildren(fragment);
}

function _getActiveGraphRenderer() {
  return mobileGraphRenderer || graphRenderer;
}

function _bindGraphControls() {
  document
    .getElementById("bme-graph-zoom-in")
    ?.addEventListener("click", () => _getActiveGraphRenderer()?.zoomIn());
  document
    .getElementById("bme-graph-zoom-out")
    ?.addEventListener("click", () => _getActiveGraphRenderer()?.zoomOut());
  document
    .getElementById("bme-graph-reset")
    ?.addEventListener("click", () => _getActiveGraphRenderer()?.resetView());
}

// ==================== 闂傚倸鍊烽懗鍫曞储瑜旈獮鏍敃閿曗偓绾剧懓鈹戦悩瀹犲缁炬儳顭烽弻銊モ攽閸℃ê顦╅柣搴㈢瀹€鎼佸蓟閵娾晛绫嶉柛銉厛濡嫰姊?====================

function _appendNodeDetailReadOnly(container, labelText, valueText) {
  const row = document.createElement("div");
  row.className = "bme-node-detail-field";
  const label = document.createElement("label");
  label.textContent = labelText;
  const value = document.createElement("div");
  value.className = "value";
  value.textContent = String(valueText ?? "闂?);
  row.append(label, value);
  container.appendChild(row);
}

function _appendNodeDetailNumberInput(
  container,
  labelText,
  inputId,
  value,
  { min, max, step } = {},
) {
  const row = document.createElement("div");
  row.className = "bme-node-detail-field";
  const label = document.createElement("label");
  label.setAttribute("for", inputId);
  label.textContent = labelText;
  const input = document.createElement("input");
  input.type = "number";
  input.id = inputId;
  input.className = "bme-node-detail-input";
  if (min != null) input.min = String(min);
  if (max != null) input.max = String(max);
  if (step != null) input.step = String(step);
  input.value =
    value === undefined || value === null ? "" : String(Number(value));
  row.append(label, input);
  container.appendChild(row);
}

function _appendNodeDetailTextInput(container, labelText, inputId, value) {
  const row = document.createElement("div");
  row.className = "bme-node-detail-field";
  const label = document.createElement("label");
  label.setAttribute("for", inputId);
  label.textContent = labelText;
  const input = document.createElement("input");
  input.type = "text";
  input.id = inputId;
  input.className = "bme-node-detail-input";
  input.value = String(value ?? "");
  row.append(label, input);
  container.appendChild(row);
}

function _parseNodeDetailScopeList(rawValue, { allowSlash = true } = {}) {
  const normalized = String(rawValue ?? "")
    .replace(/[闂?闂傚倸鍊烽悞锕傚礈濮樿泛纾婚柛娑卞枙缁?/g, "/")
    .replace(/\r/g, "\n");
  const separatorPattern = allowSlash ? /[,\n闂?\\]+/ : /[,\n闂傚倸鍊烽悞锔锯偓绗涘懐鐭欓柟杈鹃檮閸?/;
  const values = normalized
    .split(separatorPattern)
    .map((entry) => entry.trim())
    .filter(Boolean);
  return [...new Set(values)];
}

function _appendNodeDetailTextareaField(
  container,
  labelText,
  fieldKey,
  fieldType,
  text,
) {
  const row = document.createElement("div");
  row.className = "bme-node-detail-field";
  const label = document.createElement("label");
  label.textContent = labelText;
  const ta = document.createElement("textarea");
  ta.className = "bme-node-detail-textarea";
  ta.dataset.bmeFieldKey = fieldKey;
  ta.dataset.bmeFieldType = fieldType;
  ta.rows = String(text || "").length > 160 ? 6 : 3;
  ta.value = text;
  row.append(label, ta);
  container.appendChild(row);
}

function _showNodeDetail(node) {
  const detailEl = document.getElementById("bme-node-detail");
  const titleEl = document.getElementById("bme-detail-title");
  const bodyEl = document.getElementById("bme-detail-body");
  if (!detailEl || !titleEl || !bodyEl) return;

  const raw = node.raw || node;
  const fields = raw.fields || {};
  titleEl.textContent = getNodeDisplayName(raw);
  detailEl.dataset.editNodeId = raw.id || "";

  const fragment = document.createDocumentFragment();

  _appendNodeDetailReadOnly(fragment, "缂傚倸鍊搁崐椋庢閿熺姴纾诲鑸靛姦閺佸鎲搁弮鍫濈畺?, _typeLabel(raw.type));
  _appendNodeDetailReadOnly(
    fragment,
    "濠电姷鏁搁崑鐘诲箵椤忓棗绶ら柛鎾楀啫鐏婇柟鍏肩暘閸斿矂寮告笟鈧弻鏇㈠醇濠垫劖笑闂?,
    buildScopeBadgeText(raw.scope),
  );
  _appendNodeDetailReadOnly(fragment, "ID", raw.id || "闂?);
  _appendNodeDetailReadOnly(
    fragment,
    "闂傚倷鑳堕幊鎾诲触鐎ｎ亶鐒芥繛鍡樺灦瀹曟煡鏌熼悧鍫熺凡闁搞劌鍊归妵鍕疀閹捐泛顣洪梺?,
    raw.seqRange?.[1] ?? raw.seq ?? 0,
  );

  const scope = normalizeMemoryScope(raw.scope);
  if (scope.layer === "pov") {
    _appendNodeDetailReadOnly(
      fragment,
      "POV 闂備浇宕甸崰鎰垝鎼淬垺娅犳俊銈呭暞閺嗘粓鏌熼悜姗嗘畷闁?,
      `${scope.ownerType || "unknown"} / ${scope.ownerName || scope.ownerId || "闂?}`,
    );
  }
  const regionLine = buildRegionLine(scope);
  if (regionLine) {
    _appendNodeDetailReadOnly(fragment, "闂傚倸鍊风欢姘焽婵犳碍鈷旈柛鏇ㄥ亽閻斿棙淇婇鐐达紵闁?, regionLine);
  }
  _appendNodeDetailTextInput(
    fragment,
    "濠电姷鏁搁崑鐐哄垂閸洖绠插〒姘ｅ亾妞ゃ垺淇洪ˇ鏌ユ煥閺囨ê鐏叉鐐达耿椤㈡瑩鎳栭埡濠冃?,
    "bme-detail-scope-region-primary",
    scope.regionPrimary || "",
  );
  _appendNodeDetailTextInput(
    fragment,
    "闂傚倸鍊风欢姘焽婵犳碍鈷旈柛鏇ㄥ亽閻斿棙淇婇鐐达紵闁绘帒锕ラ妵鍕冀閵娧呯厑閻庤娲栭ˇ浼村Φ閸曨垰鍐€闁靛濡囧▓銈囩磽?(闂?/ 闂傚倸鍊风粈渚€骞夐敍鍕殰闁圭儤鍤﹀☉妯锋斀闁糕€崇箲閻?",
    "bme-detail-scope-region-path",
    Array.isArray(scope.regionPath) ? scope.regionPath.join(" / ") : "",
  );
  _appendNodeDetailTextInput(
    fragment,
    "婵犵數濮烽弫鎼佸磻濞戞娑氣偓闈涙啞椤洟鏌￠崶鈺佹珡婵炲牅绮欓弻娑㈠Ψ椤旂厧顫╅梺鍦嚀閻栧ジ寮婚埄鍐ㄧ窞濠电姴瀚搹搴ㄦ⒒?(闂傚倸鍊烽悞锕€顪冮崹顕呯劷闁秆勵殔缁€澶愭煙鏉堝墽鐣遍柣鎺戠仛閵囧嫰骞掑鍥獥濠电偛鐗婂濠氬箟閹间礁绾ч柟绋块娴犳潙螖?/ 闂傚倸鍊风粈渚€骞夐敍鍕殰闁圭儤鍤﹀☉妯锋斀闁糕€崇箲閻?",
    "bme-detail-scope-region-secondary",
    Array.isArray(scope.regionSecondary)
      ? scope.regionSecondary.join(", ")
      : "",
  );
  if (Array.isArray(raw.seqRange)) {
    _appendNodeDetailReadOnly(
      fragment,
      "闂傚倷鑳堕幊鎾诲触鐎ｎ亶鐒芥繛鍡樺灦瀹曟煡鏌熼悧鍫熺凡闁搞劌鍊归妵鍕疀閹捐泛顤€闂佹悶鍊栭崹鍧楀蓟濞戙垹绠涢柍杞扮椤绱?,
      `${raw.seqRange[0]} ~ ${raw.seqRange[1]}`,
    );
  }
  _appendNodeDetailTextareaField(
    fragment,
    "闂傚倸鍊风粈渚€骞夐敓鐘茬闁糕剝绋戠粈瀣亜閹扳晛鐏╂い銉ョЧ濮婄粯鎷呴崨濠冨創闂佸摜鍣ラ崑濠囧箖閵夆晜鍋傛?,
    "__storyTime",
    "json",
    JSON.stringify(raw.storyTime || {}, null, 2),
  );
  _appendNodeDetailTextareaField(
    fragment,
    "闂傚倸鍊风粈渚€骞夐敓鐘茬闁糕剝绋戠粈瀣亜閹扳晛鐏╂い銉ョЧ濮婄粯鎷呴崨濠冨創闂佸摜鍣ラ崑濠囧箖閵夆晜鍋傛鐑嗗墯閻╊垰鐣风粙璇炬梹鎷呴崨濠庡悋闂傚倷绀侀幉锟犲礉閹达箑绀夌€广儱娲ㄥΛ?,
    "__storyTimeSpan",
    "json",
    JSON.stringify(raw.storyTimeSpan || {}, null, 2),
  );

  _appendNodeDetailNumberInput(
    fragment,
    "闂傚倸鍊搁崐鐑芥倿閿曚降浜归柛鎰典簽閻捇鏌ｉ幋婵愭綗闁逞屽墮閹虫﹢寮崒鐐村殟闁靛鍎辨俊?(0闂?0)",
    "bme-detail-importance",
    raw.importance ?? 5,
    { min: 0, max: 10, step: 0.1 },
  );
  _appendNodeDetailNumberInput(
    fragment,
    "闂傚倷娴囧畷鍨叏瀹曞洨鐭嗗ù锝呭閻掍粙鏌嶉妷锔剧獮婵炴垶纰嶅畷澶愭偠濞戞帒澧查柣搴☆煼濮婃椽寮妷锔界彅闂佸摜鍣ラ崹浼村煝?,
    "bme-detail-accesscount",
    raw.accessCount ?? 0,
    { min: 0, step: 1 },
  );

  const clustersStr = Array.isArray(raw.clusters)
    ? raw.clusters.join(", ")
    : "";
  _appendNodeDetailTextInput(
    fragment,
    "闂傚倸鍊峰ù鍥ㄧ珶閸喆浠堢紒瀣儥濞尖晠鏌曟繛褍瀚禒蹇擃渻閵堝棗濮х紒鐘冲灴瀹曟﹢鍩€椤掑嫭鈷戦柟鑲╁仜閸旀鏌￠崨顏呮珚鐎?(闂傚倸鍊搁崐椋庢閿熺姴纾婚柛娑欑暘閳ь剙鍟村畷銊╂嚋椤戞寧鐫忛梻浣侯潒閸曞灚鐣剁紓浣插亾闁糕剝绋掗悡鏇㈡煃閳轰礁鏆熼柍顖涙礃閵?",
    "bme-detail-clusters",
    clustersStr,
  );

  const section = document.createElement("div");
  section.className = "bme-node-detail-section";
  section.textContent = "闂傚倷娴囧畷鍨叏閹惰姤鍊块柨鏇楀亾妞ゎ厼鐏濊灒闁稿繒鍘ф惔濠囨⒑缁嬫寧婀板瑙勬礋瀹曟垿骞橀弬銉︻潔濠电偛妫欒摫闁伙絽鍢查—?;
  fragment.appendChild(section);

  for (const [key, value] of Object.entries(fields)) {
    const isJson = typeof value === "object" && value !== null;
    const displayVal = isJson
      ? JSON.stringify(value, null, 2)
      : String(value ?? "");
    _appendNodeDetailTextareaField(
      fragment,
      key,
      key,
      isJson ? "json" : "string",
      displayVal,
    );
  }
  bodyEl.replaceChildren(fragment);

  detailEl.classList.add("open");
}

function _saveNodeDetail() {
  const detailEl = document.getElementById("bme-node-detail");
  const bodyEl = document.getElementById("bme-detail-body");
  const nodeId = detailEl?.dataset?.editNodeId;
  if (!nodeId || !bodyEl) return;
  if (_isGraphWriteBlocked()) {
    toastr.error("闂備浇宕甸崰鎰垝鎼淬垺娅犳俊銈呮噹缁犱即鏌涘☉姗堟敾婵炲懐濞€閺岋絽螣濞嗘儳娈梺缁樺姇閿曨亪寮婚悢鐑樺枂闁告洦鍋勯～宥夋⒑濮瑰洤濡介柛銊ф暬閸┿儲寰勯幇顒傤啋閻庤娲栧▔锕傚閵忊€虫瀾闂佺粯顨呴悧蹇涘矗閳ь剟鎮楃憴鍕闁挎岸鏌嶇拠鍙夊攭缂佺姵鐩獮姗€鎼归銉у彂闂傚倸鍊烽悞锔锯偓绗涘懐鐭欓柟杈鹃檮閸庢銆掑锝呬壕濡炪們鍨哄畝鎼併€佸Δ鍛＜婵犲﹤鎳愰崢顖炴煟鎼达紕鐣柛搴ㄤ憾楠炲﹨绠涘☉妯硷紮闂佹眹鍨归幉锟犳偂閺囥垺鐓欓梺顓ㄧ畱婢т即宕幖浣光拺?, "ST-BME");
    return;
  }

  const updates = { fields: {} };
  const impEl = document.getElementById("bme-detail-importance");
  if (impEl && impEl.value !== "") {
    const imp = Number.parseFloat(impEl.value);
    if (Number.isFinite(imp)) {
      updates.importance = Math.max(0, Math.min(10, imp));
    }
  }
  const accessEl = document.getElementById("bme-detail-accesscount");
  if (accessEl && accessEl.value !== "") {
    const ac = Number.parseInt(accessEl.value, 10);
    if (Number.isFinite(ac)) {
      updates.accessCount = Math.max(0, ac);
    }
  }
  const clustersEl = document.getElementById("bme-detail-clusters");
  if (clustersEl) {
    updates.clusters = clustersEl.value
      .split(/[,闂傚倸鍊烽悞锔锯偓绗涘懐鐭欓柟杈鹃檮閸?)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  const regionPrimaryEl = document.getElementById("bme-detail-scope-region-primary");
  const regionPathEl = document.getElementById("bme-detail-scope-region-path");
  const regionSecondaryEl = document.getElementById("bme-detail-scope-region-secondary");
  if (regionPrimaryEl || regionPathEl || regionSecondaryEl) {
    updates.scope = {
      regionPrimary: String(regionPrimaryEl?.value || "").trim(),
      regionPath: _parseNodeDetailScopeList(regionPathEl?.value, {
        allowSlash: true,
      }),
      regionSecondary: _parseNodeDetailScopeList(regionSecondaryEl?.value, {
        allowSlash: true,
      }),
    };
  }

  const fieldEls = bodyEl.querySelectorAll("[data-bme-field-key]");
  for (const el of fieldEls) {
    const key = el.dataset.bmeFieldKey;
    const type = el.dataset.bmeFieldType || "string";
    const rawVal = el.value;
    if (key === "__storyTime" || key === "__storyTimeSpan") {
      try {
        updates[key === "__storyTime" ? "storyTime" : "storyTimeSpan"] = JSON.parse(
          rawVal || "{}",
        );
      } catch {
        toastr.error(`闂傚倷娴囬褏鈧稈鏅濈划娆撳箳濡炲皷鍋撻崘顔煎耿婵炴垼椴搁弲鈺呮倵閸忓浜鹃梺鍛婃处閸?{key === "__storyTime" ? "闂傚倸鍊风粈渚€骞夐敓鐘茬闁糕剝绋戠粈瀣亜閹扳晛鐏╂い銉ョЧ濮婄粯鎷呴崨濠冨創闂佸摜鍣ラ崑濠囧箖閵夆晜鍋傛? : "闂傚倸鍊风粈渚€骞夐敓鐘茬闁糕剝绋戠粈瀣亜閹扳晛鐏╂い銉ョЧ濮婄粯鎷呴崨濠冨創闂佸摜鍣ラ崑濠囧箖閵夆晜鍋傛鐑嗗墯閻╊垰鐣风粙璇炬梹鎷呴崨濠庡悋闂傚倷绀侀幉锟犲礉閹达箑绀夌€广儱娲ㄥΛ?}闂傚倸鍊风欢姘焽瑜嶈灋婵°倕鍟伴惌鎾舵喐閻楀牆绗掓潻婵嬫椤愩垺澶勬慨濠傤煼閸┿垽寮崼鐔哄幈濠电娀娼уΛ妤咁敂椤忓牊鐓曞┑鐐茬仢閳ь剚鐗滈幑?JSON`, "ST-BME");
        return;
      }
      continue;
    }
    if (type === "json") {
      try {
        updates.fields[key] = JSON.parse(rawVal || "null");
      } catch {
        toastr.error(`闂傚倷娴囬褏鈧稈鏅濈划娆撳箳濡炲皷鍋撻崘顔煎耿婵炴垼椴搁弲鈺呮倵閸忓浜鹃梺鍛婃处閸?{key}闂傚倸鍊风欢姘焽瑜嶈灋婵°倕鍟伴惌鎾舵喐閻楀牆绗掓潻婵嬫椤愩垺澶勬慨濠傤煼閸┿垽寮崼鐔哄幈濠电娀娼уΛ妤咁敂椤忓牊鐓曞┑鐐茬仢閳ь剚鐗滈幑?JSON`, "ST-BME");
        return;
      }
    } else {
      updates.fields[key] = rawVal;
    }
  }

  const result = _actionHandlers.saveGraphNode?.({
    nodeId,
    updates,
  });
  if (!result?.ok) {
    toastr.error(
      result?.error === "node-not-found"
        ? "闂傚倸鍊烽懗鍫曞储瑜旈獮鏍敃閿曗偓绾剧懓鈹戦悩瀹犲缁炬儳顭烽弻銊モ攽閸℃ê顎涢梺鍝ュ枎閹虫ê螞閸涙惌鏁冩い鎰╁灩缁犲姊洪懡銈呮瀾缂佽鐗撻獮鍐ㄎ旈埀顒勫煡婢跺ň鏋嶆い鎾楀倻鐩庨梺鎸庢磸閸ㄤ粙銆侀弮鍫濋唶闁绘柨鎲￠悵顐︽煟鎼粹€冲辅闁稿鎹囬弻娑㈠箛椤撶偛濮㈠┑鐐茬墛閻撯€愁潖閾忓湱鐭欓悹鎭掑妿椤斿绻濋悽闈涗粶闁挎洏鍊涢悘瀣⒑閸︻叀妾搁柛鐘崇墱閹叉挳鏁冮崒姘鳖啇濠电儑缍嗛崜娆愪繆閸忚偐绠鹃柛娑卞亜閻忔煡鏌?
        : "濠电姷鏁搁崕鎴犲緤閽樺娲晜閻愵剙搴婇梺绋跨灱閸嬬偤宕戦妶澶嬬厪濠电姴绻掗悾杈╃磼閸撲礁浠辩€殿喖鐖煎畷濂割敃椤厼鍤遍柣?,
      "ST-BME",
    );
    return;
  }
  if (result.persistBlocked) {
    toastr.warning(
      "闂傚倸鍊风粈渚€骞夐敓鐘茬闁哄洢鍨圭粻鐘诲箹閹碱厾鍘涢柡浣革躬閺岀喖鏌囬敃鈧晶濠氭煕閻旈攱鍤囬柡灞剧☉閳诲氦绠涢敐鍠把呯磽娴ｉ缚妾搁柛銊ョ埣瀵鏁撻悩鑼紲濠殿喗锕╅崜娑㈡儎鎼达絿纾藉ù锝勭矙閸濊櫣绱掔拠鎻掓殻妤犵偛绻樺畷銊╁级閹存繆鈧灝鈹戞幊閸婃劙宕戦幘缁樼厸闁告侗鍠楅崐鎰版煛鐏炲墽娲村┑锛勬焿椤︽彃霉閻橆偅娅呴棁澶嬬節婵犲倹鍣规い锝堝亹閳ь剙鐏氬妯尖偓姘嵆瀹曟椽鍩勯崘鈺侇€撶紓浣割儓濞夋洟鎮烽弻銉︹拻濞达綀濮ら妴鍐煠鐎圭姴鐓愰柡鍛版硾铻栭柍褜鍓熼幃楣冨垂椤愩倗鎳濋梺閫炲苯澧柣锝囧厴閺佹劖寰勫Ο缁樻珫婵犵數濞€濞佳兾涘Δ鍛祦閻庯綆鍠楅悡鐔兼煟閹邦厽缍戦柛銈庡墴閺屾稓鈧綆浜濋崳浠嬫煃瑜滈崜姘跺传鎼淬劌纾规繝闈涱儑瀹撲線鎮楅敐搴℃珮闁轰礁鍊块獮鏍ㄦ綇閸撗勫仹濡炪倧瀵岄崳锝夊蓟閿濆鍋愰柛娆忣槸閺嬬娀姊虹悰鈥充壕闂備緡鍓欑粔鐢稿磻閸岀偞鐓ラ柣鏂挎惈鏍￠梺绋垮閸ㄥ潡骞冨Δ鍛櫜閹煎瓨绻勯崙鍦磽娴ｇ鈧悂鎮ч幘璇茬畺闁革富鍘搁崑鎾绘晲鎼粹€崇闂佸憡鍑归崑鍕煘閹达富鏁婇柤鎭掑劚閳ь剚鍔栭〃銉╂倷閳轰椒澹?,
      "ST-BME",
    );
  } else {
    toastr.success("闂傚倸鍊烽懗鍫曞储瑜旈獮鏍敃閿曗偓绾剧懓鈹戦悩瀹犲缁炬儳顭烽弻銊モ攽閸℃ê顎涢梺鍝ュ枎閹虫ê螞閸涙惌鏁冩い鎰╁灩缁犺崵绱撴担鍝勑＄紒顔界懇楠?, "ST-BME");
  }

  const r = _getActiveGraphRenderer();
  const sel = r?.selectedNode;
  if (sel?.id === nodeId && sel.raw) {
    _showNodeDetail(sel);
  } else {
    const g = _getGraph?.();
    const rawN = g?.nodes?.find((n) => n.id === nodeId);
    if (rawN) {
      _showNodeDetail({ raw: rawN, id: rawN.id });
    }
  }
  refreshLiveState();
}

function _bindNodeDetailPanel() {
  const saveBtn = document.getElementById("bme-detail-save");
  if (saveBtn && saveBtn.dataset.bmeBound !== "true") {
    saveBtn.addEventListener("click", () => _saveNodeDetail());
    saveBtn.dataset.bmeBound = "true";
  }
  const deleteBtn = document.getElementById("bme-detail-delete");
  if (deleteBtn && deleteBtn.dataset.bmeBound !== "true") {
    deleteBtn.addEventListener("click", () => _deleteNodeDetail());
    deleteBtn.dataset.bmeBound = "true";
  }
}

function _deleteNodeDetail() {
  const detailEl = document.getElementById("bme-node-detail");
  const nodeId = detailEl?.dataset?.editNodeId;
  if (!nodeId) return;
  if (_isGraphWriteBlocked()) {
    toastr.error("闂備浇宕甸崰鎰垝鎼淬垺娅犳俊銈呮噹缁犱即鏌涘☉姗堟敾婵炲懐濞€閺岋絽螣濞嗘儳娈梺缁樺姇閿曨亪寮婚悢鐑樺枂闁告洦鍋勯～宥夋⒑濮瑰洤濡介柛銊ф暬閸┿儲寰勯幇顒傤啋閻庤娲栧▔锕傚閵忊€虫瀾闂佺粯顨呴悧蹇涘矗閳ь剟鎮楃憴鍕闁挎岸鏌嶇拠鍙夊攭缂佺姵鐩獮姗€鎼归銉у彂闂傚倸鍊烽悞锔锯偓绗涘懐鐭欓柟杈鹃檮閸庢銆掑锝呬壕濡炪們鍨哄畝鎼併€佸Δ鍛＜婵犲﹤鎳愰崢顖炴煟鎼达紕鐣柛搴ㄤ憾楠炲﹨绠涘☉妯硷紮闂佹眹鍨归幉锟犳偂閺囥垺鐓欓梺顓ㄧ畱婢т即宕幖浣光拺?, "ST-BME");
    return;
  }
  const g = _getGraph?.();
  const node = g?.nodes?.find((n) => n.id === nodeId);
  const label = node ? getNodeDisplayName(node) : nodeId;
  if (
    !confirm(
      `缂傚倸鍊烽懗鍫曟惞鎼淬劌鐭楅幖娣妼缁愭鏌″搴″箺闁稿鏅涜灃闁挎繂鎳庨弳娆戠磼閳ь剟宕卞☉娆戝幗濠碘槅鍨甸崑鎰暜濞戙垺鐓熸繝闈涚墕閺嬫盯鏌＄仦璇测偓婵嗙暦椤愶箑绀嬫い鎰枎娴滄儳鈹戦悩瀹犲缁炬儳顭烽弻銊モ攽閸♀晜笑閺?{label}闂傚倸鍊风欢姘焽瑜嶈灋婵°倕鍟伴惌娆撴煕閺囥劌骞楁い顐ｆ礈缁辨帡鍩€椤掑嫭鍋犵紒顐ゅ灁闂傚倸鍊风粈渚€宕ョ€ｎ喗鍎戠憸鐗堝笒绾惧潡鏌熺紒銏犳珮闁轰礁顑嗛幈銊ノ熼崹顔惧帿闂佹悶鍊曠粔褰掑蓟濞戞矮娌柛鎾楀懐鍘愬┑鐐差嚟婵參宕归崼鏇炶摕闁跨喓濮撮柋鍥ㄧ節閸偄濮堢粭鎴︽⒒娴ｈ銇熷ù婊勭箖缁旂喖宕卞☉娆忓墻濡炪倕绻愬ù鍌毼ｆ繝姘拺闁绘垟鏅涙晶鏌ユ煟閻斿弶娅婃鐐诧躬閹瑩宕崟顓ㄧ床婵犵數濮撮敃銈夊疮閳哄懎绀岄柡宥庡幗閳锋垿鏌熺粙鎸庢崳闁宠棄顦甸弻銈吤虹拠鑼桓闂佽鍨伴崯瀛樻叏閳ь剟鏌ㄥ☉妯侯仱闁哄鐗犲娲焻閻愯尪瀚板褎鎸抽弻锝呪槈閸楃偞鐏撻梺鍦嚀鐎氭澘鐣烽锕€绀嬫い鎾寸箖閸嬪懘姊婚崒姘偓鎼佸磹閸濄儮鍋撳銉ュ鐎规洘鍔欓獮瀣晝閳ь剟鎮為崹顐犱簻闁瑰搫妫楁禍楣冩⒑缁嬪尅宸ョ紓宥咃躬閵嗕礁螖閳ь剟鍩為幋鐘亾閿濆簼绨芥い鏃€鎹囬幃妤呯嵁閸喖濮庨柣搴㈠嚬閸犳氨鍒掑▎鎰瘈闁稿本顨嗛～宥夋⒑鐟欏嫬鍔ょ痪缁㈠幖閻☆參鏌ｉ悢鍝ョ煂濠⒀勵殜閹繝鍨惧畷鍥ㄦ闂佺粯鍨煎Λ鍕劔闂備焦瀵уΛ浣规叏閵堝洠鍋撳顓炩枙婵﹤顭峰畷鎺戭潩閸楃儐鏆ラ梻浣规偠閸斿矂骞栭锔光偓锕傚垂椤曞懏寤洪梺閫炲苯澧柣锝呭槻椤粓鍩€椤掆偓閻ｇ兘濡搁埡濠冩櫓闂佽姤锚椤︿粙宕靛鍫熲拻闁稿本鐟чˇ锔剧磼閵娾晙鎲剧€规洘鍨块獮妯肩磼濡厧甯鹃梻浣虹《閸撴繂煤濠婂懐涓?
    )
  ) {
    return;
  }
  const result = _actionHandlers.deleteGraphNode?.({ nodeId });
  if (!result?.ok) {
    toastr.error(
      result?.error === "node-not-found" ? "闂傚倸鍊烽懗鍫曞储瑜旈獮鏍敃閿曗偓绾剧懓鈹戦悩瀹犲缁炬儳顭烽弻銊モ攽閸℃ê顎涢梺鍝ュ枎閹虫ê螞閸涙惌鏁冩い鎰╁灩缁犲姊洪懡銈呮瀾缂佽鐗撻獮鍐ㄎ旈埀顒勫煡婢跺ň鏋嶆い鎾楀倻鐩庨梺? : "闂傚倸鍊风粈渚€骞夐敍鍕殰闁绘劕顕粻楣冩煃瑜滈崜姘辨崲濞戙垹宸濇い鎾跺剱閸斿鎮楅崹顐ｇ凡閻庢凹鍘奸…鍥疀濞戣鲸鏅濋梺?,
      "ST-BME",
    );
    return;
  }
  if (result.persistBlocked) {
    toastr.warning(
      "闂傚倸鍊烽懗鍫曞储瑜旈獮鏍敃閿曗偓绾剧懓鈹戦悩瀹犲缁炬儳顭烽弻銊モ攽閸℃ê顎涢梺鍝ュ枎閹虫ê螞閸涙惌鏁冩い鎰╁灩缁犲姊哄ú璇插箲闁稿﹥绻堝璇测槈閵忕姈銊╂煏婢跺牆鍔ょ紒瀣箻濮婃椽鎮℃惔锝勭驳闂佹悶鍔屽﹢閬嶅礆閹烘绫嶉柍褜鍓涢幑銏犫攽閸♀晜鍍靛銈嗘尵婵绱炴径鎰拻濞达絿鎳撻婊呯磼鐎ｎ偄鐏︾紒杞扮矙瀵噣宕掑杈╃摌濠德板€х徊浠嬪疮椤愩倗鐭嗛柛鎰ㄦ櫇缁犻箖鏌涢埄鍐炬畼缂佺姾灏欑槐鎺楀焵椤掑嫬鐒垫い鎺戝閳锋垿鏌涘☉姗堝姛闁硅櫕鍔欓弻娑㈠Ω瑜庨弳顒傗偓瑙勬礃椤ㄥ懓鐏掗梺绋跨箳閸樠勭韫囨搩娓婚柕鍫濇婵呯磼闊厾鐭欐い銏℃閺佹捇鎮╁畷鍥у箥闂備礁婀遍埛鍫ュ储濞差亜绠栫€广儱娲ㄧ壕濂稿级閸稑濡跨紒鐘筹耿閺岀喐顦版惔鈾€鏋呴梺鍝勮閸斿酣鍩€椤掑﹦绉甸柛鎾寸懃椤曪綁濡搁埡鍌楁嫼濠电偠灏濠勮姳缂佹ǜ浜滈柟瀛樼箖閸ｅ綊妫佹径瀣╃箚妞ゆ牗鑹鹃幃鎴︽倵濮樼厧澧寸€殿喖鐖煎畷鐓庮潩椤撶喓褰呯紓浣诡殕閸ㄥ灝顫?,
      "ST-BME",
    );
  } else {
    toastr.success("闂傚倸鍊烽懗鍫曞储瑜旈獮鏍敃閿曗偓绾剧懓鈹戦悩瀹犲缁炬儳顭烽弻銊モ攽閸℃ê顎涢梺鍝ュ枎閹虫﹢寮婚悢铏圭＜婵☆垵娅ｉ悷銊╂⒑鐠囪尙绠氶柡鍛Т椤?, "ST-BME");
  }
  detailEl?.classList.remove("open");
  if (detailEl) delete detailEl.dataset.editNodeId;
  graphRenderer?.highlightNode?.("__cleared__");
  mobileGraphRenderer?.highlightNode?.("__cleared__");
  refreshLiveState();
}

function _bindClose() {
  document
    .getElementById("bme-panel-close")
    ?.addEventListener("click", closePanel);
  document.getElementById("bme-detail-close")?.addEventListener("click", () => {
    document.getElementById("bme-node-detail")?.classList.remove("open");
  });
  overlayEl?.addEventListener("click", (event) => {
    if (event.target === overlayEl) closePanel();
  });
}

function _bindResizeHandle() {
  const handle = document.getElementById("bme-resize-handle");
  const sidebar = panelEl?.querySelector(".bme-panel-sidebar");
  if (!handle || !sidebar) return;

  let dragging = false;
  let startX = 0;
  let startWidth = 0;

  handle.addEventListener("mousedown", (e) => {
    e.preventDefault();
    dragging = true;
    startX = e.clientX;
    startWidth = sidebar.offsetWidth;
    handle.classList.add("dragging");
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  });

  document.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const delta = e.clientX - startX;
    const newWidth = Math.max(180, Math.min(600, startWidth + delta));
    sidebar.style.width = newWidth + "px";
    sidebar.style.minWidth = newWidth + "px";
  });

  document.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove("dragging");
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  });
}

const PANEL_SIZE_KEY = "st-bme-panel-size";
let _panelResizeTimer = null;

function _bindPanelResize() {
  if (!panelEl || typeof ResizeObserver === "undefined") return;
  const observer = new ResizeObserver(() => {
    clearTimeout(_panelResizeTimer);
    _panelResizeTimer = setTimeout(() => {
      if (!overlayEl?.classList.contains("active")) return;
      const w = panelEl.offsetWidth;
      const h = panelEl.offsetHeight;
      if (w > 0 && h > 0) {
        try {
          localStorage.setItem(PANEL_SIZE_KEY, JSON.stringify({ w, h }));
        } catch { /* ignore */ }
      }
    }, 300);
  });
  observer.observe(panelEl);
}

function _restorePanelSize() {
  if (!panelEl) return;
  if (_isMobile()) {
    panelEl.style.width = "";
    panelEl.style.height = "";
    return;
  }
  try {
    const raw = localStorage.getItem(PANEL_SIZE_KEY);
    if (!raw) return;
    const { w, h } = JSON.parse(raw);
    if (Number.isFinite(w) && Number.isFinite(h) && w > 200 && h > 200) {
      panelEl.style.width = w + "px";
      panelEl.style.height = h + "px";
    }
  } catch { /* ignore */ }
}

async function _runCognitionNodeOverrideAction(mode = "") {
  const graph = _getGraph?.();
  const ownerEntries = _getCognitionOwnerCollection(graph);
  const ownerEntry =
    ownerEntries.find((entry) => entry.ownerKey === currentCognitionOwnerKey) || null;
  const selectedNode = _getSelectedGraphNode(graph);

  if (!ownerEntry) {
    toastr.info("闂傚倸鍊烽懗鍫曗€﹂崼銏″床闁规壆澧楅崑瀣煙閹规劦鍤欓柣鎺戠仛閵囧嫰骞掗崱妞惧婵＄偑鍊ч梽鍕珶閸℃稑鐒垫い鎺嶇閹兼悂鏌涢弬璺ㄐょ紒顔界懄瀵板嫰骞囬鍌氬Е婵＄偑鍊栫敮濠囨嚄閸洖鐓濋柡鍐ｅ亾闁靛洤瀚粻娑㈠箻鐎垫悶鍋愭繝鐢靛仧閵嗗鎹㈠┑瀣摕闁靛牆娲﹂崗婊堟煕濠娾偓缁€浣糕枔濠靛牏纾藉ù锝勭矙閸濊櫣绱掔拠鑼闁伙絽鍢茶灒濞撴凹鍨伴幃鎴︽⒑閸撴彃浜介柛瀣瀵煡顢橀悩鐢碉紳闂佺鏈懝楣冨几閵堝鐓曢柣妯虹－濞插瓨銇勯姀鈭╂垹鎹㈠┑鍡╂僵妞ゆ挾鍋涙竟鎺楁⒒娓氣偓濞佳囁囨禒瀣亗闁割偅绶峰ú顏嶆晢闁告洦鍓涢崢?, "ST-BME");
    return;
  }
  if (!selectedNode?.id) {
    toastr.info("闂傚倸鍊烽懗鍫曗€﹂崼銏″床闁规壆澧楅崑瀣煕閳╁喚娈ｉ柤鐗堝閵囧嫯绠涢幘璺侯暫闂佺粯鍔曢敃顏堝蓟閻旂儤鍠嗛柛鏇ㄥ亜椤秹姊哄Ч鍥у闁搞劌娼″濠氭偄鐞涒€充壕婵炴垶鐟悞钘夘熆瑜戝▍鏇㈠Φ閸曨垰妫橀柟绋挎捣閳规稓绱撴担鍝勑ｉ柣鈺婂灠閻ｇ兘宕￠悙宥嗘閸┾偓妞ゆ帒瀚崐鑸电箾閸℃ɑ灏伴柛瀣У缁绘盯骞嬮悙闈涒吂婵犳鍠栭崐鍧楀蓟濞戙垺鏅查柛銉戝啫绠ｉ梻浣筋嚃閸犳鎮烽埡鍛摕闁告侗鍘稿Σ鍫熸叏濮椻偓濡法妲愬Ο琛℃斀闁绘劖娼欓悘锕傛煙鐏忔牗娅嗙紒鍌氱Ч閺佹劙宕遍弴鐘电暰婵＄偑鍊栭幐鍫曞垂濞差亜纾?, "ST-BME");
    return;
  }

  let result = null;
  if (mode === "clear") {
    result = await _actionHandlers.clearKnowledgeOverride?.({
      ownerKey: ownerEntry.ownerKey,
      ownerType: ownerEntry.ownerType,
      ownerName: ownerEntry.ownerName,
      nodeId: selectedNode.id,
    });
  } else {
    result = await _actionHandlers.applyKnowledgeOverride?.({
      ownerKey: ownerEntry.ownerKey,
      ownerType: ownerEntry.ownerType,
      ownerName: ownerEntry.ownerName,
      nodeId: selectedNode.id,
      mode,
    });
  }

  if (!result?.ok) {
    const messageMap = {
      "graph-write-blocked": "闂備浇宕甸崰鎰垝鎼淬垺娅犳俊銈呮噹缁犱即鏌涘☉姗堟敾婵炲懐濞€閺岋絽螣濞嗘儳娈梺缁樺姇閿曨亪寮婚悢鐑樺枂闁告洦鍋勯～宥夋⒑濮瑰洤濡介柛銊ョ仢椤曪綁宕奸弴鐐靛幐闂佺顑愰崹鍏肩濠婂牊鏅濋柕蹇嬪€ら弫鍌炴煕濞戝崬鐏欓柡鈧崘娴嬫斀闁绘绮☉褎绻涚仦鍌氣偓娑€傛禒瀣拻濞达絽鎲￠崯鐐烘煕閺冣偓閻楃娀骞冮悜钘壩ㄩ柍杞拌兌閻撴垿姊虹化鏇炲⒉缂佸甯￠崺娑㈠箻缂佹鍘鹃梺鍛婄☉椤剟宕箛娑欑厱闁绘劖澹嗛惌娆撴煛鐏炶濡奸柍钘夘槸铻ｉ柤娴嬫櫅婵増淇婇悙顏勨偓鏍洪敃鍌氱婵炴垶鑹鹃崹婵囩箾閸℃绂嬮柛姘儔閺屾稑鈽夐崡鐐寸亪闂侀€炲苯澧伴柡浣割煼瀵鈽夐姀鐘电杸濡炪倖甯掗崐鎰板Ψ閳哄倻鍘?,
      "node-not-found": "闂傚倷绀侀幖顐λ囬锕€鐤炬繝濠傜墛閸嬶繝鏌曢崼婵愭Ч闁绘挸鍊圭换婵囩節閸屾粌顤€闂佹悶鍊曠粔褰掑蓟濞戞矮娌柛鎾楀懐鍘愬┑鐐差嚟婵參宕归幎钘夌劦妞ゆ帒鍠氬鎰版煟閳╁啯绀堝ù婊咁焾閳诲酣骞嬪┑鍡欎喊闂備焦鏋奸弲娑㈠疮娴兼潙鐓濋柡鍐ㄥ€甸崑鎾荤嵁閸喖濮庨梺纭呮珪閸旀瑩鐛Δ鍛亹缂備焦顭囬崢閬嶆⒑閹稿孩鐓ラ柟纰卞亝娣囧﹪鎼归崷顓狅紲濡炪値鍘界敮鐐靛姬閳ь剟姊烘潪鎵槮缂佸鎸抽幃鎯р攽鐎ｎ亞顦ㄩ梺璇″瀻閸曢潧鏁奸梻鍌氬€搁崐鐑芥倿閿曚降浜归柛鎰典簽閻捇鏌ｉ姀銏╃劸闁藉啰鍠庨埞鎴︽偐閸欏顦╅梺缁樺笩椤曆団€︾捄銊﹀磯濞撴凹鍨伴崜鏉款渻?,
      "owner-not-found": "婵犵數濮烽弫鎼佸磻濞戞瑥绶為柛銉墮缁€鍫熺節闂堟稒锛旈柤鏉跨仢閵嗘帒顫濋敐鍛婵°倗濮烽崑娑氱矓瑜版帞宓侀柛鈩冨嚬濡插姊虹紒妯诲碍闁稿﹤鐏濋锝夊醇閺囩偟鍘搁梺绋挎湰缁秹宕抽妷鈺傗拻濞达絿顭堢痪褏绱掗濂稿弰妤犵偛顦甸獮姗€顢欓懖鈺婂敽闂備礁鎼ú銊╁磿閹邦儵娑樼暆閸曨兘鎷哄┑顔炬嚀濞层倖淇婃總鍛婂€垫慨妯煎帶閻忥附銇勯姀鈭╂垹鎹㈠┑鍡╂僵妞ゆ挾鍋涙竟鎺楁⒒娓氣偓濞佳囨晬韫囨稑绀冮柛鎰硶閻ｇ敻鏌″畝鈧崰鏍€侀弽顐ｅ磯闁靛ě鍛啠缂傚倸鍊峰ù鍥ㄣ仈閸濄儲宕查柛鏇ㄥ灠缁狀垶鏌ｅΟ鍨毢闁哄棗顑夐弻鈩冨緞婵犲嫪铏庨悗娈垮枟椤ㄥ﹪寮婚敐澶嬪亹閺夊牜鍋掗崬褰掓⒑閸濆嫭鍣洪柣鈺婂灡娣囧﹪骞嗛懜顑挎睏闂佸湱鍎ら崹褰掓偂閹达附鈷戠紒瀣濠€浼存煟閻旀繂娲﹂崑锟犳煏韫囨洖袥婵℃彃鐗撻弻鐔虹磼閵忕姷浠╂繛瀛樼矒缁犳牠寮婚埄鍐ㄧ窞閻忕偠妫勬竟澶愭⒑閸濄儱校妞ゃ劌顦垫俊鐢稿箛椤撶姷鎳濋梺閫炲苯澧柣?,
    };
    toastr.error(messageMap[result?.error] || "闂傚倷娴囧畷鍨叏閹惰姤鈷旂€广儱顦壕瑙勪繆閵堝懏鍣洪柛瀣€块弻銊モ槈濡警浠鹃梺鍝ュ枑濡炰粙寮诲☉銏犵労闁告劦浜濋崳顓犵磼閸撗冧壕婵犮垺锕㈤垾锕傚锤濡も偓缁犳岸鏌熷▓鍨灓缂傚牓浜堕弻?, "ST-BME");
    return;
  }

  const successMap = {
    known: "闂備浇顕ф绋匡耿闁秮鈧箓宕煎┑鎰闂佸壊鍋呭ú姗€宕戞径鎰叆婵犻潧妫欐径鍕攽椤栨粌甯堕摶鐐参涙０浣哄妽缂佷焦澹嗙槐鎺楀焵椤掑倵鍋撻敐搴″幋闁稿鎸搁埢鎾诲垂椤旂晫浜梻浣告贡閳峰牓宕戞繝鍌滄殾闁告繂瀚€閺冨牆鐒垫い鎺戝閺佸﹪鐓崶銊р姇闁搞倖鍨堕妵鍕箳閹存績鍋撶粙娆惧殨?,
    hidden: "闂備浇顕ф绋匡耿闁秮鈧箓宕煎┑鎰闂佸壊鍋呭ú姗€宕戞径鎰叆婵犻潧妫欐径鍕攽椤栨粌甯堕摶鐐参涙０浣哄妽缂佷焦澹嗙槐鎺楀焵椤掑倵鍋撻敐搴″幋闁稿鎸搁埢鎾诲垂椤旂晫浜梻浣告贡閳峰牓宕戞繝鍌滄殾闁告繂瀚€閺冨牆宸濇い鏃囶潐鐎垫姊绘担鍝ョШ闁稿锕畷褰掓焼瀹?,
    mistaken: "闂備浇顕ф绋匡耿闁秮鈧箓宕煎┑鎰闂佸壊鍋呭ú姗€宕戞径鎰叆婵犻潧妫欐径鍕攽椤栨粌甯堕摶鐐参涙０浣哄妽缂佷焦澹嗙槐鎺楀焵椤掑倵鍋撻敐搴℃灍闁稿缍侀弻娑㈠Ψ閵婏妇銆愰梺璇茬箞閸庢娊骞?,
    clear: "闂備浇顕ф绋匡耿闁秮鈧箓宕煎┑鎰闂佸憡鎸烽懗鍫曞础濮橆兘鏀介柣妯虹－椤ｆ煡鏌嶉柨瀣棃闁哄本娲熷畷鐓庘攽閸績鎷￠梻浣规偠閸婃洟藝閻㈢钃熼柕鍫濐槸娴肩娀鏌涢弴銊ヤ簮闁稿鎸荤换婵嗩潩椤掑偊绱遍梻浣瑰缁诲倿藝娴兼潙纾跨€广儱顦伴悡鏇㈡煛閸ャ儱濡煎褜鍠楅妵鍕Χ閸曨厾鐛㈤梺鍝勬湰閻╊垰顕ｉ鍌涘珰闁圭粯甯╁濠冧繆閻愵亜鈧劙寮查埡鍛；濠电姴娲ょ粻?,
  };
  if (result.persistBlocked) {
    toastr.warning(
      `${successMap[mode] || "闂傚倷娴囧畷鍨叏閹惰姤鈷旂€广儱顦壕瑙勪繆閵堝懏鍣洪柛瀣€块弻銊モ槈濡警浠鹃梺鍝ュ枑濡炰粙寮诲☉銏犵労闁告劦浜濋崳顓犵磼閸撗冧壕濠㈢懓妫濋崺鈧い鎺嗗亾婵犫偓闁秮鈧箓宕煎┑鎰闁荤姴鎼妶钘壝洪鍕暅濠德板€愰崑鎾翠繆?}闂傚倸鍊烽悞锔锯偓绗涘懐鐭欓柟瀵稿仧闂勫嫰鏌￠崘銊モ偓鍝ユ閵堝鐓欐い鏍ф閺堫剙顩奸妸鈺傗拺闁圭娴风粻鎾绘煙閾忣偄濮夋繛鎴犳暬閸┾偓妞ゆ帒瀚埛鎴︽煕濞戞﹫宸ュ┑顔肩墦閺岋綁鎮㈤弶鎴濆闁绘挶鍊濋弻鈥愁吋鎼粹€崇闂佹椿鍘介〃鍡涘Φ閸曨垰鍐€闁靛ě鍛殼闂備礁鎲¤摫婵炲吋鐟╁﹢渚€姊虹紒姗嗙劸閻忓繑鐟ラ悺顓熺節閻㈤潧袥闁稿鎸婚妵鍕疀閹炬惌妫ゆ俊鐐垫嚀閸熷潡鈥︾捄銊﹀磯闁绘碍娼欐慨娑氱磽娴ｇ懓濮х紒缁樼箞瀵鈽夐姀鐘栥劑鏌ㄩ弴妤€浜剧紓浣插亾闁告劏鏅滈崣蹇斾繆椤栨粠鐒惧┑鈥崇仢闇夋繝濠傚暞閸熺偞绻涢悡搴ｇ闁糕斁鍓濋幏鍛村传閵夘垳鍚筦,
      "ST-BME",
    );
  } else {
    toastr.success(successMap[mode] || "闂傚倷娴囧畷鍨叏閹惰姤鈷旂€广儱顦壕瑙勪繆閵堝懏鍣洪柛瀣€块弻銊モ槈濡警浠鹃梺鍝ュ枑濡炰粙寮诲☉銏犵労闁告劦浜濋崳顓犵磼閸撗冧壕濠㈢懓妫濋崺鈧い鎺嗗亾婵犫偓闁秮鈧箓宕煎┑鎰闁荤姴鎼妶钘壝洪鍕暅濠德板€愰崑鎾翠繆?, "ST-BME");
  }
  _refreshDashboard();
}

async function _applyManualActiveRegionFromDashboard(clear = false) {
  const input = document.getElementById("bme-cognition-manual-region");
  const region = clear ? "" : String(input?.value || "").trim();
  const result = await _actionHandlers.setActiveRegion?.({ region });
  if (!result?.ok) {
    const messageMap = {
      "graph-write-blocked": "闂傚倸鍊烽悞锕傚箖閸洖纾块柟缁樺笧閺嗭附淇婇娆掝劅婵炲皷鏅犻弻鏇熺節韫囨稒顎嶆繛瀛樺殠閸婃牗绌辨繝鍥舵晬婵犲﹤鍟俊娲⒒婵犲骸澧婚柛鎾寸懆瑜颁線姊洪幖鐐插姌闁告柨娴风划濠氬冀瑜夐弨鑺ャ亜閺傛寧鎯堥柣蹇氬皺閳ь剝顫夊ú姗€鏁嬮梺瀹狀嚙濮橈妇绮诲☉銏犵闁惧浚鍋夌欢銏ゆ⒒閸屾艾鈧悂宕愰幖浣哥柈闁规儼妫勯弰銉╂煛瀹ュ骸寮鹃柡浣革功閳ь剙鍘滈崑鎾绘煕閺囥劌澧繛鍛墵閺岋綀绠涢弴鐐版埛闂佺顑嗛幑鍥箖妤ｅ喚鏁嶉柣鎰嚟閸樻悂姊洪崨濠傚闁哄懏绮撳鎼佸礋椤撶姷锛滃┑掳鍊愰崑鎾淬亜閿旂偓鏆鐐诧工铻栭柛娑卞枛濞堢喖姊洪棃娑辨闂傚嫬瀚濠㈣埖鍔栭埛鎴︽⒒閸碍娅婃俊缁㈠枟缁绘繈濮€閳藉棛鍔锋繛?,
      "missing-graph": "闂備浇宕甸崰鎰垝鎼淬垺娅犳俊銈呮噹缁犱即鏌涘☉姗堟敾婵炲懐濞€閺岋絽螣閼姐們鍋為梺鍝勭焿缁犳捇寮诲澶婄厸濞达絽鎲″▓鑼磽娴ｅ搫校閻㈩垽绻濆璇测槈濡攱鐎诲┑鈽嗗灥濞咃絾绂掗鐐粹拺閺夌偘鍗冲鐑芥煕婵犲啰绠撻柣锝囧厴瀹曞ジ寮撮悙娈垮敼闂備礁缍婇崑濠囧储閹€鏋?,
    };
    toastr.error(messageMap[result?.error] || "闂傚倸鍊风粈渚€骞栭鈷氭椽濡舵径瀣槐闂侀潧艌閺呮盯鎷戦悢灏佹斀闁绘ê寮堕崳宄懊瑰鍐Ш闁哄瞼鍠栭獮鍡氼槻闁哄棜椴搁妵鍕Χ閸涱喖娈楅梺鍝勬湰閻╊垶寮崒鐐村殟闁靛／鍐ㄦ闂備浇顕х换鎰瑰璺哄瀭闁告鍎愰崵妤呮煕閺囥劌澧紓宥呮处閵囧嫰骞囬埡浣稿?, "ST-BME");
    return;
  }

  if (result.persistBlocked) {
    toastr.warning(
      clear ? "闂備浇顕ф绋匡耿闁秮鈧箓宕煎┑鎰闂佺厧鎽滈弫鎼併€呴柨瀣ㄤ簻闁哄啫娲﹂ˉ澶岀磼閸撲礁浠ч柍褜鍓欑粻宥夊磿闁秵鍋嬮柛鈩冦仜閺嬫柨霉閻撳海鎽犻柣鎾存礋閺岋繝宕掑┑鎰婵犵鈧啿鎮戠紒缁樼箞閸┾偓妞ゆ帒瀚粻缁樸亜閺冨洤浜规い锕備憾濮婅櫣绱掑Ο鍨棟濡炪倖娲﹂崢鍓у垝閸喎绶炲┑鐐村笒缂嶅﹪寮幇鏉垮窛妞ゆ洖鎳忛敍浣逛繆閻愵亜鈧牜鏁Δ鍐ㄥ灊鐎光偓閸曞灚鏅梺鎸庣箓閻楀繘鎮块埀顒勬⒑鐟欏嫬绀冩繛鍛礀閳诲秹濮€閵堝棌鎷洪梺纭呭亹閸嬫盯宕濋妶澶嬬厱閻庯綆鍓欏暩闂佺懓绠嶉崹钘夘嚕閹绢喖顫呴柣妯哄暱缁佸爼姊绘笟鈧褑鍣归梺鍛婁緱閸犳宕曢鐐寸厽閹艰揪绱曟禒娑欑節閵忊槄鑰挎鐐诧攻閹棃鍩堥崜浣瑰殌閾伙綁鏌涜箛鏇炲付妞ゅ繆鏅犲娲川婵犲孩鐣奸梺绋款儑閸嬨倝骞嗛崘顔肩闁绘鏁搁敍? : "闂備浇宕甸崰鎰垝鎼淬垺娅犳俊銈呮噹缁犱即鏌涘☉姗堟敾婵炲懐濞€閺岋絽螣濞嗘儳娈梺鍦嚀閻栧ジ寮婚埄鍐ㄧ窞濠电姴瀚搹搴ㄦ⒒閸屾碍鍣烘い顓炴喘閸┾偓妞ゆ巻鍋撴繝鈧柆宥佲偓锕傚醇濠垫劕娈ㄩ柣鐘叉惈閵堣棄煤椤忓嫰鏁滃┑掳鍊愰崑鎾翠繆椤愶綇鑰块柟顔荤矙椤㈡盯鏁愰崨顔句壕缂傚倷璁查崑鎾愁熆鐠鸿　濮囩憸鐗堝笚閺呮煡鏌涘☉鍗炴珮婵☆偀鈧剚娓婚柕鍫濇缁楁氨绱掗鑲╃劯妞ゃ垺宀搁弫鎰板醇閵忋垺婢戦梻浣筋潐瀹曟ê鈻嶉弴鐐╂瀺闁靛繈鍊栭埛鎴︽煙閼测晛浠滈柛鏂诲€濋弻娑氣偓锝庡墮鍟搁梺鐟扮畭閸ㄨ棄顕ｉ幘顔碱潊闁绘ê鍟跨粊鍫曟⒒娓氣偓濞佳嗗櫣闂佸憡渚楅崰妤呭磿椤栫偞鐓熼幖杈剧磿娴犳稒绻濋姀鈽呰€挎鐐诧攻閹棃鍩堥崜浣瑰殌閾伙綁鏌涜箛鏇炲付妞ゅ繆鏅犲娲川婵犲孩鐣奸梺绋款儑閸嬨倝骞嗛崘顔肩闁绘鏁搁敍?,
      "ST-BME",
    );
  } else {
    toastr.success(clear ? "闂備浇顕ф绋匡耿闁秮鈧箓宕煎┑鎰闂佺厧鎽滈弫鎼併€呴柨瀣ㄤ簻闁哄啫娲﹂ˉ澶岀磼閸撲礁浠ч柍褜鍓欑粻宥夊磿闁秵鍋嬮柛鈩冦仜閺嬫柨霉閻撳海鎽犻柣鎾存礋閺岋繝宕掑┑鎰婵犵鈧啿鎮戠紒缁樼箞閸┾偓妞ゆ帒瀚粻缁樸亜閺冨洤浜规い锕備憾濮婃椽宕ㄦ繝鍕暤闁诲孩鍑归崜鐔煎箖濮椻偓瀵濡烽敂鎯у箰? : "闂備浇宕甸崰鎰垝鎼淬垺娅犳俊銈呮噹缁犱即鏌涘☉姗堟敾婵炲懐濞€閺岋絽螣濞嗘儳娈梺鍦嚀閻栧ジ寮婚埄鍐ㄧ窞濠电姴瀚搹搴ㄦ⒒閸屾碍鍣烘い顓炴喘閸┾偓妞ゆ巻鍋撴繝鈧柆宥佲偓锕傚醇濠垫劕娈ㄩ柣鐘叉惈閵堣棄煤椤忓嫰鏁滃┑掳鍊愰崑鎾翠繆?, "ST-BME");
  }
  _refreshDashboard();
}

async function _saveRegionAdjacencyFromDashboard() {
  const graph = _getGraph?.();
  const regionInput = document.getElementById("bme-cognition-manual-region");
  const adjacencyInput = document.getElementById("bme-cognition-adjacency-input");
  const historyState = graph?.historyState || {};
  const region = String(
    regionInput?.value ||
      historyState.activeRegion ||
      graph?.regionState?.manualActiveRegion ||
      "",
  ).trim();
  const adjacent = String(adjacencyInput?.value || "")
    .split(/[,\n闂傚倸鍊烽悞锔锯偓绗涘懐鐭欓柟杈鹃檮閸?)
    .map((value) => String(value || "").trim())
    .filter(Boolean);

  if (!region) {
    toastr.info("闂傚倸鍊烽懗鍫曗€﹂崼銏″床闁规壆澧楅崑瀣煕閳╁啰鈯曢柡鍛叀閺岋綁骞囬澶婃闂佸磭绮Λ鍐蓟瀹ュ牜妾ㄩ梺鍛婃尰濮樸劎鍒掑▎鎰窞闁规澘鐏氶弲婊堟⒑閸涘﹥澶勯柛妯煎亾閻″繘姊婚崒娆戭槮闁硅绻濋獮鎰板传閵壯呯厠闂佸搫顦伴崺濠囨嚀閸ф鐓欑紓浣靛灩閺嬫稓绱掗埀顒€鐣濋崟顒傚幗濠殿喗锕╅崜锕傚吹閻旇櫣纾奸柍褜鍓氬鍕箛椤撶姴骞堥梻浣哥秺閸嬪﹪宕滃☉妯兼瘓缂傚倸鍊烽懗鍓佸垝椤栨凹娼╅柕濞炬櫅閻掑灚銇勯幒宥堝厡闁愁垱娲熼弻銊╁即濡櫣浼堥悗瑙勬礃閸ㄥ潡寮崘顔肩＜婵﹢纭搁崬娲⒒娓氣偓濞佳囁囬銏犵？閺夊牜鍋佹禍褰掓煟濡吋鏆╃痪?, "ST-BME");
    return;
  }

  const result = await _actionHandlers.updateRegionAdjacency?.({
    region,
    adjacent,
  });
  if (!result?.ok) {
    const messageMap = {
      "graph-write-blocked": "闂傚倸鍊烽悞锕傚箖閸洖纾块柟缁樺笧閺嗭附淇婇娆掝劅婵炲皷鏅犻弻鏇熺節韫囨稒顎嶆繛瀛樺殠閸婃牗绌辨繝鍥舵晬婵犲﹤鍟俊娲⒒婵犲骸澧婚柛鎾寸懆瑜颁線姊洪幖鐐插姌闁告柨娴风划濠氬冀瑜夐弨鑺ャ亜閺傛寧鎯堥柣蹇氬皺閳ь剝顫夊ú姗€鏁嬮梺瀹狀嚙濮橈妇绮诲☉銏犵闁惧浚鍋夌欢銏ゆ⒒閸屾艾鈧悂宕愰幖浣哥柈闁规儼妫勯弰銉╂煛瀹ュ骸寮鹃柡浣革功閳ь剙鍘滈崑鎾绘煕閺囥劌澧繛鍛墵閺岋綀绠涢弴鐐版埛闂佺顑嗛幑鍥箖妤ｅ喚鏁嶉柣鎰嚟閸樻悂姊洪崨濠傚闁哄懏绮撳鎼佸礋椤撶姷锛滃┑掳鍊愰崑鎾淬亜閿旂偓鏆鐐诧工铻栭柛娑卞枛濞堢喖姊洪棃娑辨闂傚嫬瀚濠㈣埖鍔栭埛鎺戙€掑顒佹悙妤犵偞顭囩槐鎺楊敋閸涱厾浠梺杞扮贰閸ｏ綁鐛鈧、娆撴嚃閳哄﹥袧闂佽姘﹂～澶娒洪弽顬℃椽顢橀姀鐘殿槯?,
      "missing-region": "缂傚倸鍊搁崐鎼佸磹閹间礁纾归柟闂寸缁犺銇勯幇鍫曟闁稿骸绉甸妵鍕冀椤愵澀绮堕梺鍦嚀閻栧ジ寮婚埄鍐ㄧ窞濠电姴瀚搹搴ㄦ⒒閸屾碍鍣洪柨鏇樺灲瀵鈽夊鍡樺兊濡炪倖甯掗崐鐢稿几瀹€鈧槐鎾存媴娴犲鎽电紓浣筋嚙閻楀棝顢氶敐澶樻晪闁逞屽墴楠炲啴鍩℃担鐑樻闂佹悶鍎崕顕€宕戦幘瀵哥瘈闁稿鍟块柊锝呯暦閸洖惟鐟滃繘鎮鹃悽鍛娾拺閻庣櫢闄勫妯绘叏閸岀偞鐓涢悘鐐跺Г瀹告繄绱掓潏銊ョ瑨閾伙綁鏌涘┑鍡楊伌婵?,
    };
    toastr.error(messageMap[result?.error] || "濠电姷鏁搁崕鎴犲緤閽樺娲晜閻愵剙搴婇梺绋跨灱閸嬬偤宕戦妶澶嬬厪濠电偟鍋撳▍鍛存煙閻熸壆鍩ｉ柡灞稿墲瀵板嫭绻濋崟顏囨闂傚倸鍊搁幊蹇涙晝閵忕媭娼栨繛宸憾閺佸洭鏌ｅ鈧褏绮敓鐘崇厽闁靛繆鏅涢悘鐘绘煟鎺抽崝宀勵敋閵夆晛绀嬫い鎺嶈兌缁夎泛顪冮妶鍡楀闁?, "ST-BME");
    return;
  }

  if (result.persistBlocked) {
    toastr.warning("闂傚倸鍊搁崐椋庢閿熺姴鍌ㄩ柛鎾楀啫鐏婂銈嗙墬缁秹寮冲鍫熺厵缂備降鍨归弸娑氱磼閳ь剟宕掑┃鎯т壕閻熸瑥瀚粈鈧┑鐐叉▕閸欏啫鐣峰Δ鍛倞闁宠鍎虫禍楣冩煕閿旇寮鹃柣鎺戝⒔閳ь剚顔栭崰娑樷枖濞戞艾寮查梻浣侯潒閸曞灚鐣跺┑鈽嗗亝閿曘垽骞冩禒瀣垫晬闁挎繂鎳忛悘鎾剁磽娴ｆ彃浜炬繝銏ｆ硾閳洝銇愰幒鎾存珳闂佸憡渚楅崳顔嘉涢垾鎰佹富闁靛牆妫楃粭姘辩磼椤旇偐鐒告い銏″哺閺佹劙宕奸姀銏℃緫闂備浇顫夊畷妯衡枍閺囩偐鏋嶉柕蹇嬪€栭埛鎴︽煙閼测晛浠滈柛鏂诲€濋弻娑氣偓锝庡墮鍟搁梺鐟扮畭閸ㄨ棄顕ｉ幘顔碱潊闁绘ê鍟跨粊鍫曟⒒娓氣偓濞佳嗗櫣闂佸憡渚楅崰妤呭磿椤栫偞鐓熼幖杈剧磿娴犳稒绻濋姀鈽呰€挎鐐诧攻閹棃鍩堥崜浣瑰殌閾伙綁鏌涜箛鏇炲付妞ゅ繆鏅犲娲川婵犲孩鐣奸梺绋款儑閸嬨倝骞嗛崘顔肩闁绘鏁搁敍?, "ST-BME");
  } else {
    toastr.success("闂備浇宕甸崰鎰垝鎼淬垺娅犳俊銈呮噹缁犱即鏌涘☉姗堟敾婵炲懐濞€閺岋絽螣濞嗘儳娈梺鍦嚀閻栧ジ寮婚埄鍐ㄧ窞濠电姴瀚搹搴ㄦ⒒閸屾碍鍣洪柨鏇樺灩椤繐煤椤忓秵鏅ｉ梺缁橈耿濞佳呯箔閿熺姵鐓熼柕蹇婃櫅閻忊剝绻涢崗鑲╂噰妞ゃ垺鐟ㄧ粻娑樷槈濮橆剙绲兼俊鐐€栭幐鐐叏閻戠瓔鏁婇柡鍐ㄧ墛閻?, "ST-BME");
  }
  _refreshDashboard();
}

function _bindDashboardControls() {
  const ownerList = document.getElementById("bme-cognition-owner-list");
  if (ownerList && ownerList.dataset.bmeBound !== "true") {
    ownerList.addEventListener("click", (event) => {
      const button = event.target.closest?.("[data-owner-key]");
      if (!button) return;
      const ownerKey = String(button.dataset.ownerKey || "").trim();
      if (!ownerKey) return;
      currentCognitionOwnerKey = ownerKey;
      _refreshDashboard();
    });
    ownerList.dataset.bmeBound = "true";
  }

  const detail = document.getElementById("bme-cognition-detail");
  if (detail && detail.dataset.bmeBound !== "true") {
    detail.addEventListener("click", async (event) => {
      const button = event.target.closest?.("[data-bme-cognition-node-action]");
      if (!button || button.disabled) return;
      await _runCognitionNodeOverrideAction(
        String(button.dataset.bmeCognitionNodeAction || ""),
      );
    });
    detail.dataset.bmeBound = "true";
  }

  const regionApply = document.getElementById("bme-cognition-region-apply");
  if (regionApply && regionApply.dataset.bmeBound !== "true") {
    regionApply.addEventListener("click", async () => {
      await _applyManualActiveRegionFromDashboard(false);
    });
    regionApply.dataset.bmeBound = "true";
  }

  const regionClear = document.getElementById("bme-cognition-region-clear");
  if (regionClear && regionClear.dataset.bmeBound !== "true") {
    regionClear.addEventListener("click", async () => {
      await _applyManualActiveRegionFromDashboard(true);
    });
    regionClear.dataset.bmeBound = "true";
  }

  const adjacencySave = document.getElementById("bme-cognition-adjacency-save");
  if (adjacencySave && adjacencySave.dataset.bmeBound !== "true") {
    adjacencySave.addEventListener("click", async () => {
      await _saveRegionAdjacencyFromDashboard();
    });
    adjacencySave.dataset.bmeBound = "true";
  }
}

// ==================== 闂傚倸鍊烽懗鍫曞箠閹剧粯鍊舵繝闈涚墢閻挾鈧娲栧ú銊х矆婵犲洦鐓涢柛鎰╁妼閳ь剝宕垫竟鏇熺附閸涘﹦鍘甸柣搴㈢⊕椤洨绮诲鈧弻?====================

function _bindActions() {
  const bindings = {
    "bme-act-extract": "extract",
    "bme-act-compress": "compress",
    "bme-act-sleep": "sleep",
    "bme-act-synopsis": "synopsis",
    "bme-act-summary-rollup": "summaryRollup",
    "bme-act-summary-rebuild": "rebuildSummaryState",
    "bme-act-summary-clear": "clearSummaryState",
    "bme-act-export": "export",
    "bme-act-import": "import",
    "bme-act-rebuild": "rebuild",
    "bme-act-evolve": "evolve",
    "bme-act-undo-maintenance": "undoMaintenance",
    "bme-act-vector-rebuild": "rebuildVectorIndex",
    "bme-act-vector-reembed": "reembedDirect",
    "bme-act-clear-graph": "clearGraph",
    "bme-act-clear-vector-cache": "clearVectorCache",
    "bme-act-clear-batch-journal": "clearBatchJournal",
    "bme-act-delete-current-idb": "deleteCurrentIdb",
    "bme-act-delete-all-idb": "deleteAllIdb",
    "bme-act-delete-server-sync": "deleteServerSyncFile",
    "bme-act-backup-to-cloud": "backupToCloud",
    "bme-act-restore-from-cloud": "restoreFromCloud",
    "bme-act-manage-server-backups": "manageServerBackups",
    "bme-act-rollback-last-restore": "rollbackLastRestore",
  };

  const actionLabels = {
    extract: "Extract",
    compress: "Compress",
    sleep: "Sleep",
    synopsis: "Synopsis",
    summaryRollup: "Rollup",
    rebuildSummaryState: "Rebuild Summary",
    clearSummaryState: "Clear Summary",
    export: "Export",
    import: "Import",
    rebuild: "Rebuild",
    evolve: "Evolve",
    undoMaintenance: "Undo Maintenance",
    rebuildVectorIndex: "Rebuild Vectors",
    reembedDirect: "Re-embed",
    clearGraph: "Clear Graph",
    clearVectorCache: "Clear Vector Cache",
    clearBatchJournal: "Clear Batch Journal",
    deleteCurrentIdb: "Delete Current IDB",
    deleteAllIdb: "Delete All IDB",
    deleteServerSyncFile: "Delete Server Sync",
    backupToCloud: "Backup to Cloud",
    restoreFromCloud: "Restore from Cloud",
    manageServerBackups: "Manage Server Backups",
    rollbackLastRestore: "Rollback Restore",
  };

  for (const [elementId, actionKey] of Object.entries(bindings)) {
    const btn = document.getElementById(elementId);
    if (!btn) continue;

    btn.addEventListener("click", async () => {
      const handler =
        actionKey === "manageServerBackups"
          ? _openServerBackupManagerModal
          : _actionHandlers[actionKey];
      if (!handler) return;

      const label = actionLabels[actionKey] || actionKey;
      if (btn.disabled) return;
      btn.disabled = true;
      btn.style.opacity = "0.5";

      _showActionProgressUi(label);
      toastr.info(`${label} in progress...`, "ST-BME", { timeOut: 2000 });

      try {
        const result = await handler();
        if (result?.cancelled) {
          return;
        }
        if (!result?.skipDashboardRefresh) {
          _refreshDashboard();
          _refreshGraph();
          if (
            document
              .getElementById("bme-pane-memory")
              ?.classList.contains("active")
          ) {
            _refreshMemoryBrowser();
          }
          if (
            document
              .getElementById("bme-pane-injection")
              ?.classList.contains("active")
          ) {
            await _refreshInjectionPreview();
          }
        }
        if (!result?.handledToast) {
          toastr.success(`${label} done`, "ST-BME");
        }
        void _refreshCloudBackupManualUi();
      } catch (error) {
        console.error(`[ST-BME] Action ${actionKey} failed:`, error);
        if (!error?._stBmeToastHandled) {
          toastr.error(`${label} failed: ${error?.message || error}`, "ST-BME");
        }
      } finally {
        btn.disabled = false;
        btn.style.opacity = "";
        _refreshRuntimeStatus();
        _refreshGraphAvailabilityState();
        void _refreshCloudBackupManualUi();
      }
    });
  }
}
    });
  }
}

  document
    .getElementById("bme-act-vector-range")
    ?.addEventListener("click", async () => {
      const btn = document.getElementById("bme-act-vector-range");
      if (btn?.disabled) return;
      if (btn) {
        btn.disabled = true;
        btn.style.opacity = "0.5";
      }

      _showActionProgressUi("闂傚倸鍊峰ù鍥磻閹版澘鍌ㄧ憸鏂跨暦椤栫儐鏁冮柍閿嬬濡炶棄鐣风粙璇炬梹鎷呴崫鍕瑩闂佽楠哥粻宥夊磿闁秴绠犻柟閭﹀枟椤?);
      toastr.info("闂傚倸鍊峰ù鍥磻閹版澘鍌ㄧ憸鏂跨暦椤栫儐鏁冮柍閿嬬濡炶棄鐣风粙璇炬梹鎷呴崫鍕瑩闂佽楠哥粻宥夊磿闁秴绠犻柟閭﹀枟椤?闂傚倷绀侀幖顐λ囬锕€鐤炬繝濠傛噽閻瑩鏌″搴″箲闁逞屽厸缁舵岸鐛€ｎ喗鍊风痪鐗埳戦悘鍐╀繆閻愵亜鈧牠骞愰懡銈囩煓闁割偁鍎辩壕?, "ST-BME", { timeOut: 2000 });

      try {
        const start = _parseOptionalInt(
          document.getElementById("bme-range-start")?.value,
        );
        const end = _parseOptionalInt(
          document.getElementById("bme-range-end")?.value,
        );
        await _actionHandlers.rebuildVectorRange?.(
          Number.isFinite(start) && Number.isFinite(end)
            ? { start, end }
            : null,
        );
        _refreshDashboard();
        _refreshGraph();
        toastr.success("闂傚倸鍊峰ù鍥磻閹版澘鍌ㄧ憸鏂跨暦椤栫儐鏁冮柍閿嬬濡炶棄鐣风粙璇炬梹鎷呴崫鍕瑩闂佽楠哥粻宥夊磿闁秴绠犻柟閭﹀枟椤?闂傚倷娴囬褍霉閻戣棄绠犻柟鎹愵嚙鐎氬銇勯幒鎴濐仼闁?, "ST-BME");
      } catch (error) {
        console.error("[ST-BME] Action rebuildVectorRange failed:", error);
        toastr.error(`闂傚倸鍊峰ù鍥磻閹版澘鍌ㄧ憸鏂跨暦椤栫儐鏁冮柍閿嬬濡炶棄鐣风粙璇炬梹鎷呴崫鍕瑩闂佽楠哥粻宥夊磿闁秴绠犻柟閭﹀枟椤?濠电姷鏁告慨浼村垂濞差亜纾块柤娴嬫櫅閸ㄦ繈鏌涢幘妤€瀚弸? ${error?.message || error}`, "ST-BME");
      } finally {
        if (btn) {
          btn.style.opacity = "";
        }
        _refreshRuntimeStatus();
        _refreshGraphAvailabilityState();
      }
    });

  // 闂傚倸鍊搁崐鐑芥倿閿曚降浜归柛鎰典簽閻捇鏌ｉ姀銏╃劸闁藉啰鍠庨埞鎴︽偐閸欏鎮欑紓浣哄Х閺佸寮婚悢鍏肩劷闁挎洍鍋撳褜鍠氱槐?(reroll) 缂傚倸鍊搁崐鎼佸磹閻戣姤鍊块柨鏇炲€搁崹鍌炴煟閵忕姵鍟為柛?
  document
    .getElementById("bme-act-reroll")
    ?.addEventListener("click", async () => {
      const btn = document.getElementById("bme-act-reroll");
      if (btn?.disabled) return;

      const floorStr = document.getElementById("bme-reroll-floor")?.value;
      const fromFloor = _parseOptionalInt(floorStr);
      const desc = Number.isFinite(fromFloor)
        ? `濠电姷鏁搁崑娑㈩敋椤撶喐鍙忛悗鐢电《閸嬫挸鈽夐幒鎾寸彋婵犵鈧磭鍩ｉ柟铏墵閸╋繝鍩€椤掆偓閳?${fromFloor} 闂備浇顕х€涒晠顢欓弽顓炵獥闁圭儤顨呯壕濠氭煙閻愵剚鐏遍柡鈧懞銉ｄ簻闁哄啫鍊甸幏锟犳煕鎼达紕绠茬紒缁樼洴瀹曪絾寰勭仦瑙ｅ悅婵＄偑鍊ら崢褰掑礉瀹€鍕剁稏婵犻潧顑愰弫鍡涙煕閹扳晛濡跨憸鐗堢叀濮婂宕掑▎鎴濆閻熸粍婢橀崯鎵垝閺冨牊鍋ㄧ紒瀣劵閹芥洘绻濋悽闈浶㈡繛灞傚€楃划濠氭偨閸涘﹦鍘甸梻渚囧弿缁犳垶鏅堕鍓х＜闁肩⒈鍓涢?
        : "闂傚倸鍊烽悞锕傚箖閸洖纾块柟鎯版绾惧鏌ｉ幇鐗堟锭闁搞劍绻堥弻鐔虹磼閵忕姵鐏堥柣搴㈣壘椤︾敻寮诲鍫闂佸憡鎸鹃崰搴敋?AI 婵犵數濮撮惀澶愬级鎼存挸浜炬俊銈呮噹閸屻劎鎲搁弮鍫濈疇闁绘柨鍚嬮崑鍕煕韫囨艾浜归柛妯诲浮閹鐛崹顔煎濠碘槅鍋呴悷鈺呭箖閿熺姴鐒垫い鎺戝閳锋垿鏌涢敂璇插箻閻㈩垱鐩弻娑㈠籍閳ь剙煤濠靛桅?;

      if (!confirm(`缂傚倸鍊烽懗鍫曟惞鎼淬劌鐭楅幖娣妼缁愭绻涢幋娆忕労闁轰礁娲弻銈嗘叏閹邦兘鍋撻弽顓炵柈闁告繂瀚ㄩ埀顒佸笒椤繈鏁愰崨顒€顥氶梻鍌欑窔濞艰崵寰婃ィ鍐ㄧ畺闁稿本鍑归崵鏇熴亜閹烘垵顏柛瀣儔閺屾盯顢曢敐鍥╃暭闂佺锕ョ敮鈥愁潖濞差亜宸濆┑鐘插閸ｎ參姊虹紒姗嗘畷婵炶尙鍠栭悰顕€宕橀褎鈻岄梻浣芥〃缁€浣虹矓瑜版帒绠栭柣鎰惈绾偓闂佽崵鍋炲Λ?{desc}\n\n闂備浇顕ф绋匡耿闁秮鈧箓宕煎┑鎰闂佽鍨甸崺鍥ㄧ閻熻埇鈧帒顫濋敐鍛闁诲氦顫夊ú鈺冪礊娴ｅ壊鍤曞ù鐘差儛閺佸啴鏌ㄥ┑鍡樺婵炲牊鎮傚娲嚒閵堝憛锟犳煟閹虹偟鐣辨い顓炵仢铻ｉ柛蹇曞帶鎼村﹪姊虹粙璺ㄧ伇闁稿鍋ゅ畷闈涱吋婢跺鍘遍柣蹇曞仜婢т粙鎯屾繝鍋綊鎮埀顒勫垂閸洖绠栨俊顖濇硶閻も偓闂佸湱鍋撻幆灞轿涢妷銉富闁靛牆楠告禍鍓х磼閻樿櫕灏柣锝囧厴瀹曞ジ寮撮悢灏佸亾閻戣姤鍊甸梻鍫熺⊕閸熺偟鐥銊х暤婵﹥妞藉Λ鍐ㄢ槈濞嗘ɑ顥犵紓?) {
        return;
      }

      if (btn) {
        btn.disabled = true;
        btn.style.opacity = "0.5";
      }

      _showActionProgressUi("闂傚倸鍊搁崐鐑芥倿閿曚降浜归柛鎰典簽閻捇鏌ｉ姀銏╃劸闁藉啰鍠庨埞鎴︽偐閸欏鎮欑紓浣哄Х閺佸寮婚悢鍏肩劷闁挎洍鍋撳褜鍠氱槐?);
      try {
        await _actionHandlers.reroll?.({
          fromFloor: Number.isFinite(fromFloor) ? fromFloor : undefined,
        });
        _refreshDashboard();
        _refreshGraph();
        if (
          document
            .getElementById("bme-pane-memory")
            ?.classList.contains("active")
        ) {
          _refreshMemoryBrowser();
        }
      } catch (error) {
        console.error("[ST-BME] Action reroll failed:", error);
        toastr.error(`闂傚倸鍊搁崐鐑芥倿閿曚降浜归柛鎰典簽閻捇鏌ｉ姀銏╃劸闁藉啰鍠庨埞鎴︽偐閸欏鎮欑紓浣哄Х閺佸寮婚悢鍏肩劷闁挎洍鍋撳褜鍠氱槐鎺楀箵閹烘柧铏庡銈庡幖濞硷繝鐛崱娑樼妞ゆ柨澧介崟姗€姊? ${error?.message || error}`, "ST-BME");
      } finally {
        if (btn) {
          btn.style.opacity = "";
        }
        _refreshRuntimeStatus();
        _refreshGraphAvailabilityState();
      }
    });

  // 闂傚倸鍊风粈浣革耿闁秮鈧箓宕奸妷瀣处鐎靛ジ寮堕幊閫炲洦鐓犳繛鏉戭儐濞呭啯绻涘畝濠侀偗闁哄本绋撴禒锕傚礈瑜忛悾鐢告⒑娴兼瑧鐣靛ù婊冪埣瀵鈽夐姀鐘栥劑鏌曟竟顖氬閸犳牜绱撻崒娆戝妽闁哄被鍔戦垾锕傛倻閽樺鐣?(cleanup)
  document
    .getElementById("bme-act-clear-graph-range")
    ?.addEventListener("click", async () => {
      const btn = document.getElementById("bme-act-clear-graph-range");
      if (btn?.disabled) return;

      const startStr = document.getElementById("bme-cleanup-range-start")?.value;
      const endStr = document.getElementById("bme-cleanup-range-end")?.value;
      const startSeq = _parseOptionalInt(startStr);
      const endSeq = _parseOptionalInt(endStr);

      if (btn) {
        btn.disabled = true;
        btn.style.opacity = "0.5";
      }

      _showActionProgressUi("闂傚倸鍊风粈浣革耿闁秮鈧箓宕奸妷瀣处鐎靛ジ寮堕幊閫炲洦鐓犳繛鏉戭儐濞呭啯绻涘畝濠侀偗闁哄本绋撴禒锕傚礈瑜忛悾鐢告⒑娴兼瑧鐣靛ù婊冪埣瀵鈽夐姀鐘栥劑鏌曟竟顖氬閸犳牜绱撻崒娆戝妽闁哄被鍔戦垾锕傛倻閽樺鐣?);
      try {
        await _actionHandlers.clearGraphRange?.(
          Number.isFinite(startSeq) ? startSeq : null,
          Number.isFinite(endSeq) ? endSeq : null,
        );
        _refreshDashboard();
        _refreshGraph();
        if (
          document
            .getElementById("bme-pane-memory")
            ?.classList.contains("active")
        ) {
          _refreshMemoryBrowser();
        }
      } catch (error) {
        console.error("[ST-BME] Action clearGraphRange failed:", error);
        toastr.error(`闂傚倸鍊风粈浣革耿闁秮鈧箓宕奸妷瀣处鐎靛ジ寮堕幊閫炲洦鐓犳繛鏉戭儐濞呭啯绻涘畝濠侀偗闁哄本绋撴禒锕傚礈瑜忛悾鐢告⒑娴兼瑧鐣靛ù婊冪埣瀵鈽夐姀鐘栥劑鏌曟竟顖氬閸犳牜绱撻崒娆戝妽闁哄被鍔戦垾锕傛倻閽樺鐣洪梺鍓插亝濞叉牠鐛姀鈥茬箚闁绘劗鍎ら敍鐔兼煛婢舵ê寮柡? ${error?.message || error}`, "ST-BME");
      } finally {
        if (btn) {
          btn.style.opacity = "";
        }
        _refreshRuntimeStatus();
        _refreshGraphAvailabilityState();
      }
    });

  // ==================== AI Monitor Trace 闂傚倸鍊烽懗鍫曘€佹繝鍥ф槬闁哄稁鍘介弲顏堟煟?====================

  document.addEventListener("click", (e) => {
    const toggle = e.target.closest(".bme-ai-monitor-entry__toggle");
    if (!toggle) return;
    const entry = toggle.closest(".bme-ai-monitor-entry");
    if (entry) entry.classList.toggle("is-collapsed");
  });

  // ==================== 闂傚倷娴囧畷鍨叏閹惰姤鈷旂€广儱顦壕瑙勪繆閵堝懏鍣洪柛瀣€块弻銊モ槈濡警浠鹃梺鍝ュТ濡繈寮诲☉銏犵労闁告劗鍋撻悾椋庣磽娴ｇ鈧悂鎮ц箛鏇燁潟闁规儳鐡ㄦ刊鎾煟閻旂顥嬪ù鐘虫尦濮?====================

  // 闂傚倸鍊烽悞锕傚箖閸洖纾块柟缁樺笧閺嗭附淇婇娆掝劅婵?闂傚倷娴囧畷鍨叏閹惰姤鈷旂€广儱顦壕瑙勪繆閵堝懏鍣洪柛瀣€块弻銊モ槈濡警浠鹃梺鍝ュТ濡繈寮诲☉銏犵労闁告劗鍋撻悾椋庣磽?tab 闂傚倸鍊风粈渚€骞夐敍鍕殰闁圭儤鍤氬ú顏呮櫇闁逞屽墴閹?
  panelEl?.querySelectorAll(".bme-graph-view-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      _switchGraphView(tab.dataset.graphView);
    });
  });

  // 缂傚倸鍊搁崐椋庣矆娓氣偓钘濋柟鍓佺摂閺佸鎲告惔銊ョ疄闁靛ň鏅涢悡娑㈡煕閹板吀绨荤€规洏鍎遍—鍐Χ閸℃瑥顫х紒鐐緲缁夊墎鍒掔€ｎ喖閱囬柕澶涚畱娴?闂傚倷娴囧畷鍨叏閹惰姤鈷旂€广儱顦壕瑙勪繆閵堝懏鍣洪柛?tab 闂傚倸鍊风粈渚€骞夐敍鍕殰闁圭儤鍤氬ú顏呮櫇闁逞屽墴閹?
  document.querySelectorAll(".bme-mobile-graph-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      _switchMobileGraphView(tab.dataset.mobileView);
    });
  });

  // 闂傚倸鍊烽懗鍫曗€﹂崼銏″床闁割偁鍎辩粈澶屸偓鍏夊亾闁告洦鍓欓崜鐢告⒑缁洖澧茬紒瀣灴閹瑦绻濋崶銊у幍闁荤喐鐟ョ€氼剚鎱ㄩ崼銉︾厽?
  document.getElementById("bme-mobile-open-fullscreen")?.addEventListener("click", _openFullscreenGraph);
  document.getElementById("bme-fs-close")?.addEventListener("click", _closeFullscreenGraph);

  // 闂傚倷娴囧畷鍨叏閹惰姤鈷旂€广儱顦壕瑙勪繆閵堝懏鍣洪柛瀣€块弻銊モ槈濡警浠鹃梺鍝ュТ濡繈寮诲☉銏犵労闁告劗鍋撻悾椋庣磽娴ｇ鈧悂鎮ч幘璇茬畺鐎瑰嫭澹嬮弸搴ㄦ煙闁箑澧版い鎴濆缁绘繈濮€閵忊€虫畬闂佹寧娲︽禍婊堟偩瀹勯偊娼╂い鎴旀櫆濡啫鐣烽悢鐓庣厴闁诡垎鍌氼棜闂備礁鎲￠崝锕傚窗濡ゅ懎纾归柣鎴ｅГ閻撶喖鏌ｉ弬鎸庡暈缂佽泛寮堕幈?
  document.getElementById("bme-cog-owner-list")?.addEventListener("click", (e) => {
    const card = e.target.closest("[data-owner-key]");
    if (!card) return;
    currentCognitionOwnerKey = card.dataset.ownerKey;
    _refreshCognitionWorkspace();
  });

  // Dashboard 闂傚倷娴囧畷鍨叏閹绢喖绠规い鎰堕檮閸嬵亪鏌涢妷顔句汗鐟滅増甯掗獮銏＄箾閸℃ê濮囨い搴㈢洴濮婃椽妫冨☉姘暫濠电偛鐪伴崝鎴濈暦閿濆鐒垫い鎺戝閻撶喖鏌ｉ弬鎸庢喐闁瑰啿鍟穱濠囶敃閿濆孩鐣堕梻?
  document.getElementById("bme-cognition-jump-to-view")?.addEventListener("click", () => {
    _switchTab("dashboard");
    _switchGraphView("cognition");
  });

  // 闂傚倷娴囧畷鍨叏閹惰姤鈷旂€广儱顦壕瑙勪繆閵堝懏鍣洪柛瀣€块弻銊モ槈濡警浠鹃梺鍝ュТ濡繈寮诲☉銏犵労闁告劗鍋撻悾椋庣磽娴ｇ鈧悂鎮ц箛鏇燁潟闁圭儤鏌у▽顏堟煟閹伴潧鍘靛ù鐘灩閳规垿鍩ラ崱妞剧盎闂佽绻戠换鍫ャ€佸▎鎺旂杸婵炴垶顭傞妸鈺傜厪濠㈣泛鐗嗛崝姘辩磼?(delegate)
  document.getElementById("bme-cognition-workspace")?.addEventListener("click", (e) => {
    const regionApply = e.target.closest("#bme-cog-region-apply");
    const regionClear = e.target.closest("#bme-cog-region-clear");
    const adjSave = e.target.closest("#bme-cog-adjacency-save");
    const storyApply = e.target.closest("#bme-cog-story-time-apply");
    const storyClear = e.target.closest("#bme-cog-story-time-clear");

    if (regionApply) {
      const manualRegion = document.getElementById("bme-cog-manual-region")?.value?.trim();
      if (manualRegion) _callAction("setActiveRegion", { region: manualRegion });
    }
    if (regionClear) {
      _callAction("setActiveRegion", { region: "" });
    }
    if (adjSave) {
      const adjInput = document.getElementById("bme-cog-adjacency-input")?.value?.trim() || "";
      const adjList = adjInput.split(/[,闂傚倸鍊烽悞锔锯偓绗涘懐鐭欓柟杈惧瘜閺?\\]/).map((s) => s.trim()).filter(Boolean);
      const graph = _getGraph?.();
      const activeRegion = String(
        graph?.historyState?.activeRegion || graph?.historyState?.lastExtractedRegion || graph?.regionState?.manualActiveRegion || "",
      ).trim();
      if (activeRegion) _callAction("updateRegionAdjacency", { region: activeRegion, adjacent: adjList });
    }
    if (storyApply) {
      const storyLabel = document.getElementById("bme-cog-manual-story-time")?.value?.trim();
      if (storyLabel) _callAction("setActiveStoryTime", { label: storyLabel });
    }
    if (storyClear) {
      _callAction("clearActiveStoryTime", {});
    }

    // 闂傚倸鍊风粈浣虹礊婵犲偆鐒界憸鏃堛€侀弽顓炲窛妞ゆ棁妫勫鍧楁⒑閸愬弶鎯堥柛鐕佸灦瀹曨垰煤椤忓懐鍘遍梺鏂ユ櫅閸熶即骞婇崟顓犳／闁告瑣鍎卞畵鍡涙煛瀹€鈧崰鎾跺垝濞嗗繆鏋庨柣鎰靛厴閺嬪懘姊?
    const actionBtn = e.target.closest("[data-bme-cognition-node-action]");
    if (actionBtn) {
      const mode = actionBtn.dataset.bmeCognitionNodeAction;
      if (!mode) return;
      const graph = _getGraph?.();
      const selectedNode = _getSelectedGraphNode(graph);
      if (!selectedNode) return;
      const { selectedOwner } = _getCurrentCognitionOwnerSummary(graph);
      if (!selectedOwner) return;

      if (mode === "clear") {
        _callAction("clearKnowledgeOverride", { nodeId: selectedNode.id, ownerKey: selectedOwner.ownerKey });
      } else {
        _callAction("applyKnowledgeOverride", {
          nodeId: selectedNode.id,
          ownerKey: selectedOwner.ownerKey,
          ownerType: selectedOwner.ownerType || "",
          ownerName: selectedOwner.ownerName || "",
          mode,
        });
      }
      _refreshCognitionWorkspace();
    }
  });

  document.getElementById("bme-summary-workspace")?.addEventListener("click", async (e) => {
    const generateBtn = e.target.closest("#bme-summary-generate");
    const rollupBtn = e.target.closest("#bme-summary-rollup");
    const rebuildBtn = e.target.closest("#bme-summary-rebuild");
    const clearBtn = e.target.closest("#bme-summary-clear");
    const actionMap = new Map([
      [generateBtn, "synopsis"],
      [rollupBtn, "summaryRollup"],
      [rebuildBtn, "rebuildSummaryState"],
      [clearBtn, "clearSummaryState"],
    ]);
    const matched = [...actionMap.entries()].find(([element]) => Boolean(element));
    if (!matched) return;

    const [, actionKey] = matched;
    const handler = _actionHandlers[actionKey];
    if (!handler) return;

    try {
      await handler();
      _refreshDashboard();
      _refreshGraph();
      _refreshSummaryWorkspace();
      _refreshMemoryBrowser();
      void _refreshInjectionPreview();
    } catch (error) {
      console.error(`[ST-BME] summary workspace action failed: ${actionKey}`, error);
      toastr.error(String(error?.message || error || "闂傚倸鍊烽懗鍫曞箠閹剧粯鍊舵繝闈涚墢閻挾鈧娲栧ú銊х矆婵犲洦鐓涢柛鎰剁到娴滈箖鎮楅崹顐ｇ凡閻庢凹鍘奸…鍥疀濞戣鲸鏅濋梺?), "ST-BME");
    }
  });
}

function _refreshConfigTab() {
  const settings = _resolveAndPersistActiveLlmPreset(_getSettings?.() || {});
  const resolvedActiveLlmPreset = String(settings.llmActivePreset || "");
  _refreshPlannerLauncher();

  _setCheckboxValue("bme-setting-enabled", settings.enabled ?? true);
  _setCheckboxValue(
    "bme-setting-debug-logging-enabled",
    settings.debugLoggingEnabled ?? false,
  );
  _setCheckboxValue(
    "bme-setting-ai-monitor-enabled",
    settings.enableAiMonitor ?? true,
  );
  _setCheckboxValue(
    "bme-setting-hide-old-messages-enabled",
    settings.hideOldMessagesEnabled ?? false,
  );
  _setCheckboxValue(
    "bme-setting-recall-enabled",
    settings.recallEnabled ?? true,
  );
  _setCheckboxValue("bme-setting-recall-llm", settings.recallEnableLLM ?? true);
  _setCheckboxValue(
    "bme-setting-recall-vector-prefilter-enabled",
    settings.recallEnableVectorPrefilter ?? true,
  );
  _setCheckboxValue(
    "bme-setting-recall-graph-diffusion-enabled",
    settings.recallEnableGraphDiffusion ?? true,
  );
  _setCheckboxValue(
    "bme-setting-recall-multi-intent-enabled",
    settings.recallEnableMultiIntent ?? true,
  );
  _setCheckboxValue(
    "bme-setting-recall-context-query-blend-enabled",
    settings.recallEnableContextQueryBlend ?? true,
  );
  _setCheckboxValue(
    "bme-setting-recall-lexical-boost-enabled",
    settings.recallEnableLexicalBoost ?? true,
  );
  _setCheckboxValue(
    "bme-setting-recall-temporal-links-enabled",
    settings.recallEnableTemporalLinks ?? true,
  );
  _setCheckboxValue(
    "bme-setting-recall-diversity-enabled",
    settings.recallEnableDiversitySampling ?? true,
  );
  _setCheckboxValue(
    "bme-setting-recall-cooccurrence-enabled",
    settings.recallEnableCooccurrenceBoost ?? false,
  );
  _setCheckboxValue(
    "bme-setting-recall-residual-enabled",
    settings.recallEnableResidualRecall ?? false,
  );
  _setCheckboxValue(
    "bme-setting-scoped-memory-enabled",
    settings.enableScopedMemory ?? true,
  );
  _setCheckboxValue(
    "bme-setting-pov-memory-enabled",
    settings.enablePovMemory ?? true,
  );
  _setCheckboxValue(
    "bme-setting-region-scoped-objective-enabled",
    settings.enableRegionScopedObjective ?? true,
  );
  _setCheckboxValue(
    "bme-setting-cognitive-memory-enabled",
    settings.enableCognitiveMemory ?? true,
  );
  _setCheckboxValue(
    "bme-setting-spatial-adjacency-enabled",
    settings.enableSpatialAdjacency ?? true,
  );
  _setCheckboxValue(
    "bme-setting-enable-story-timeline",
    settings.enableStoryTimeline ?? true,
  );
  _setCheckboxValue(
    "bme-setting-story-time-soft-directing",
    settings.storyTimeSoftDirecting ?? true,
  );
  _setCheckboxValue(
    "bme-setting-inject-story-time-label",
    settings.injectStoryTimeLabel ?? true,
  );
  _setCheckboxValue(
    "bme-setting-inject-user-pov-memory",
    settings.injectUserPovMemory ?? true,
  );
  _setCheckboxValue(
    "bme-setting-inject-objective-global-memory",
    settings.injectObjectiveGlobalMemory ?? true,
  );
  _setCheckboxValue(
    "bme-setting-inject-low-confidence-objective-memory",
    settings.injectLowConfidenceObjectiveMemory ?? false,
  );
  _setCheckboxValue(
    "bme-setting-consolidation-enabled",
    settings.enableConsolidation ?? true,
  );
  _setCheckboxValue(
    "bme-setting-synopsis-enabled",
    settings.enableHierarchicalSummary ?? settings.enableSynopsis ?? true,
  );
  _setCheckboxValue(
    "bme-setting-visibility-enabled",
    settings.enableVisibility ?? false,
  );
  _setCheckboxValue(
    "bme-setting-cross-recall-enabled",
    settings.enableCrossRecall ?? false,
  );
  _setCheckboxValue(
    "bme-setting-smart-trigger-enabled",
    settings.enableSmartTrigger ?? false,
  );
  _setCheckboxValue(
    "bme-setting-sleep-cycle-enabled",
    settings.enableSleepCycle ?? false,
  );
  _setCheckboxValue(
    "bme-setting-auto-compression-enabled",
    settings.enableAutoCompression ?? true,
  );
  _setCheckboxValue(
    "bme-setting-prob-recall-enabled",
    settings.enableProbRecall ?? false,
  );
  _setCheckboxValue(
    "bme-setting-reflection-enabled",
    settings.enableReflection ?? false,
  );
  _setInputValue(
    "bme-setting-recall-card-user-input-display-mode",
    settings.recallCardUserInputDisplayMode ?? "beautify_only",
  );
  _setInputValue(
    "bme-setting-notice-display-mode",
    settings.noticeDisplayMode ?? "normal",
  );
  _setInputValue(
    "bme-setting-cloud-storage-mode",
    settings.cloudStorageMode || "automatic",
  );
  _refreshCloudStorageModeUi(settings);
  _setInputValue(
    "bme-setting-wi-filter-mode",
    settings.worldInfoFilterMode || "default",
  );
  _setInputValue(
    "bme-setting-wi-filter-keywords",
    settings.worldInfoFilterCustomKeywords || "",
  );
  const wiFilterCustomSection = panelEl?.querySelector(
    "#bme-wi-filter-custom-section",
  );
  if (wiFilterCustomSection) {
    wiFilterCustomSection.style.display =
      (settings.worldInfoFilterMode || "default") === "custom" ? "" : "none";
  }

  _setInputValue("bme-setting-extract-every", settings.extractEvery ?? 1);
  _setInputValue(
    "bme-setting-hide-old-messages-keep-last-n",
    settings.hideOldMessagesKeepLastN ?? 12,
  );
  _setInputValue(
    "bme-setting-extract-context-turns",
    settings.extractContextTurns ?? 2,
  );
  _setCheckboxValue(
    "bme-setting-extract-auto-delay-latest-assistant",
    settings.extractAutoDelayLatestAssistant === true,
  );
  _setInputValue("bme-setting-recall-top-k", settings.recallTopK ?? 20);
  _setInputValue("bme-setting-recall-max-nodes", settings.recallMaxNodes ?? 8);
  _setInputValue(
    "bme-setting-recall-diffusion-top-k",
    settings.recallDiffusionTopK ?? 100,
  );
  _setInputValue(
    "bme-setting-recall-llm-candidate-pool",
    settings.recallLlmCandidatePool ?? 30,
  );
  _setInputValue(
    "bme-setting-recall-llm-context-messages",
    settings.recallLlmContextMessages ?? 4,
  );
  _setInputValue(
    "bme-setting-recall-multi-intent-max-segments",
    settings.recallMultiIntentMaxSegments ?? 4,
  );
  _setInputValue(
    "bme-setting-recall-context-assistant-weight",
    settings.recallContextAssistantWeight ?? 0.2,
  );
  _setInputValue(
    "bme-setting-recall-context-previous-user-weight",
    settings.recallContextPreviousUserWeight ?? 0.1,
  );
  _setInputValue(
    "bme-setting-recall-lexical-weight",
    settings.recallLexicalWeight ?? 0.18,
  );
  _setInputValue(
    "bme-setting-recall-teleport-alpha",
    settings.recallTeleportAlpha ?? 0.15,
  );
  _setInputValue(
    "bme-setting-recall-temporal-link-strength",
    settings.recallTemporalLinkStrength ?? 0.2,
  );
  _setInputValue(
    "bme-setting-recall-dpp-candidate-multiplier",
    settings.recallDppCandidateMultiplier ?? 3,
  );
  _setInputValue(
    "bme-setting-recall-dpp-quality-weight",
    settings.recallDppQualityWeight ?? 1.0,
  );
  _setInputValue(
    "bme-setting-recall-cooccurrence-scale",
    settings.recallCooccurrenceScale ?? 0.1,
  );
  _setInputValue(
    "bme-setting-recall-cooccurrence-max-neighbors",
    settings.recallCooccurrenceMaxNeighbors ?? 10,
  );
  _setInputValue(
    "bme-setting-recall-residual-basis-max-nodes",
    settings.recallResidualBasisMaxNodes ?? 24,
  );
  _setInputValue(
    "bme-setting-recall-nmf-topics",
    settings.recallNmfTopics ?? 15,
  );
  _setInputValue(
    "bme-setting-recall-nmf-novelty-threshold",
    settings.recallNmfNoveltyThreshold ?? 0.4,
  );
  _setInputValue(
    "bme-setting-recall-residual-threshold",
    settings.recallResidualThreshold ?? 0.3,
  );
  _setInputValue(
    "bme-setting-recall-residual-top-k",
    settings.recallResidualTopK ?? 5,
  );
  _setInputValue(
    "bme-setting-recall-character-pov-weight",
    settings.recallCharacterPovWeight ?? 1.25,
  );
  _setInputValue(
    "bme-setting-recall-user-pov-weight",
    settings.recallUserPovWeight ?? 1.05,
  );
  _setInputValue(
    "bme-setting-recall-objective-current-region-weight",
    settings.recallObjectiveCurrentRegionWeight ?? 1.15,
  );
  _setInputValue(
    "bme-setting-recall-objective-adjacent-region-weight",
    settings.recallObjectiveAdjacentRegionWeight ?? 0.9,
  );
  _setInputValue(
    "bme-setting-recall-objective-global-weight",
    settings.recallObjectiveGlobalWeight ?? 0.75,
  );
  _setInputValue("bme-setting-inject-depth", settings.injectDepth ?? 9999);
  _setInputValue("bme-setting-graph-weight", settings.graphWeight ?? 0.6);
  _setInputValue("bme-setting-vector-weight", settings.vectorWeight ?? 0.3);
  _setInputValue(
    "bme-setting-importance-weight",
    settings.importanceWeight ?? 0.1,
  );
  _setInputValue(
    "bme-setting-consolidation-neighbor-count",
    settings.consolidationNeighborCount ?? 5,
  );
  _setInputValue(
    "bme-setting-consolidation-threshold",
    settings.consolidationThreshold ?? 0.85,
  );
  _setInputValue(
    "bme-setting-synopsis-every",
    settings.smallSummaryEveryNExtractions ?? settings.synopsisEveryN ?? 3,
  );
  _setInputValue(
    "bme-setting-trigger-patterns",
    settings.triggerPatterns || "",
  );
  _setInputValue(
    "bme-setting-smart-trigger-threshold",
    settings.smartTriggerThreshold ?? 2,
  );
  _setInputValue(
    "bme-setting-forget-threshold",
    settings.forgetThreshold ?? 0.5,
  );
  _setInputValue(
    "bme-setting-consolidation-auto-min-new-nodes",
    settings.consolidationAutoMinNewNodes ?? 2,
  );
  _setInputValue(
    "bme-setting-compression-every",
    settings.compressionEveryN ?? 10,
  );
  _setInputValue("bme-setting-sleep-every", settings.sleepEveryN ?? 10);
  _setInputValue(
    "bme-setting-prob-recall-chance",
    settings.probRecallChance ?? 0.15,
  );
  _setInputValue("bme-setting-reflect-every", settings.reflectEveryN ?? 10);

  _setInputValue("bme-setting-llm-url", settings.llmApiUrl || "");
  _setInputValue("bme-setting-llm-key", settings.llmApiKey || "");
  _setInputValue("bme-setting-llm-model", settings.llmModel || "");
  _populateLlmPresetSelect(settings.llmPresets || {}, resolvedActiveLlmPreset);
  _syncLlmPresetControls(resolvedActiveLlmPreset);
  _setInputValue("bme-setting-timeout-ms", settings.timeoutMs ?? 300000);

  _setInputValue("bme-setting-embed-url", settings.embeddingApiUrl || "");
  _setInputValue("bme-setting-embed-key", settings.embeddingApiKey || "");
  _setInputValue(
    "bme-setting-embed-model",
    settings.embeddingModel || "text-embedding-3-small",
  );
  _setInputValue(
    "bme-setting-embed-mode",
    settings.embeddingTransportMode || "direct",
  );
  _toggleEmbedFields(settings.embeddingTransportMode || "direct");
  _setInputValue(
    "bme-setting-embed-backend-source",
    settings.embeddingBackendSource || "openai",
  );
  _setInputValue(
    "bme-setting-embed-backend-model",
    settings.embeddingBackendModel ||
      getSuggestedBackendModel(settings.embeddingBackendSource || "openai"),
  );
  _setInputValue(
    "bme-setting-embed-backend-url",
    settings.embeddingBackendApiUrl || "",
  );
  _setCheckboxValue(
    "bme-setting-embed-auto-suffix",
    settings.embeddingAutoSuffix !== false,
  );

  _setInputValue(
    "bme-setting-extract-prompt",
    settings.extractPrompt || getDefaultPromptText("extract"),
  );
  _setInputValue(
    "bme-setting-recall-prompt",
    settings.recallPrompt || getDefaultPromptText("recall"),
  );
  _setInputValue(
    "bme-setting-consolidation-prompt",
    settings.consolidationPrompt || getDefaultPromptText("consolidation"),
  );
  _setInputValue(
    "bme-setting-compress-prompt",
    settings.compressPrompt || getDefaultPromptText("compress"),
  );
  _setInputValue(
    "bme-setting-synopsis-prompt",
    settings.synopsisPrompt || getDefaultPromptText("synopsis"),
  );
  _setInputValue(
    "bme-setting-reflection-prompt",
    settings.reflectionPrompt || getDefaultPromptText("reflection"),
  );

  _refreshFetchedModelSelects(settings);
  _refreshGuardedConfigStates(settings);
  _refreshStageCardStates(settings);
  _refreshPromptCardStates(settings);
  _refreshTaskProfileWorkspace(settings);
  _refreshMessageTraceWorkspace(settings);
  _highlightThemeChoice(settings.panelTheme || "crimson");
  _syncConfigSectionState();
}

function _bindConfigControls() {
  if (!panelEl || panelEl.dataset.bmeConfigBound === "true") return;

  panelEl.querySelectorAll(".bme-config-nav-btn").forEach((btn) => {
    if (btn.dataset.bmeBound === "true") return;
    btn.addEventListener("click", () => {
      _switchConfigSection(btn.dataset.configSection || "api");
    });
    btn.dataset.bmeBound = "true";
  });

  bindCheckbox("bme-setting-enabled", (checked) => {
    _patchSettings({ enabled: checked });
    _refreshGuardedConfigStates();
  });
  bindCheckbox("bme-setting-debug-logging-enabled", (checked) => {
    _patchSettings({ debugLoggingEnabled: checked });
  });
  bindCheckbox("bme-setting-ai-monitor-enabled", (checked) => {
    _patchSettings({ enableAiMonitor: checked });
    _refreshDashboard();
  });
  bindCheckbox("bme-setting-hide-old-messages-enabled", (checked) => {
    _patchSettings({ hideOldMessagesEnabled: checked });
  });
  bindCheckbox("bme-setting-recall-enabled", (checked) => {
    _patchSettings({ recallEnabled: checked });
    _refreshGuardedConfigStates();
    _refreshStageCardStates();
  });
  bindCheckbox("bme-setting-recall-llm", (checked) => {
    _patchSettings({ recallEnableLLM: checked });
    _refreshGuardedConfigStates();
    _refreshStageCardStates();
  });
  bindCheckbox("bme-setting-recall-vector-prefilter-enabled", (checked) => {
    _patchSettings({ recallEnableVectorPrefilter: checked });
    _refreshStageCardStates();
  });
  bindCheckbox("bme-setting-recall-graph-diffusion-enabled", (checked) => {
    _patchSettings({ recallEnableGraphDiffusion: checked });
    _refreshStageCardStates();
  });
  bindCheckbox("bme-setting-recall-multi-intent-enabled", (checked) => {
    _patchSettings({ recallEnableMultiIntent: checked });
  });
  bindCheckbox("bme-setting-recall-context-query-blend-enabled", (checked) => {
    _patchSettings({ recallEnableContextQueryBlend: checked });
  });
  bindCheckbox("bme-setting-recall-lexical-boost-enabled", (checked) => {
    _patchSettings({ recallEnableLexicalBoost: checked });
  });
  bindCheckbox("bme-setting-recall-temporal-links-enabled", (checked) => {
    _patchSettings({ recallEnableTemporalLinks: checked });
  });
  bindCheckbox("bme-setting-recall-diversity-enabled", (checked) => {
    _patchSettings({ recallEnableDiversitySampling: checked });
  });
  bindCheckbox("bme-setting-recall-cooccurrence-enabled", (checked) => {
    _patchSettings({ recallEnableCooccurrenceBoost: checked });
  });
  bindCheckbox("bme-setting-recall-residual-enabled", (checked) => {
    _patchSettings({ recallEnableResidualRecall: checked });
  });
  bindCheckbox("bme-setting-scoped-memory-enabled", (checked) => {
    _patchSettings({ enableScopedMemory: checked });
  });
  bindCheckbox("bme-setting-pov-memory-enabled", (checked) => {
    _patchSettings({ enablePovMemory: checked });
  });
  bindCheckbox(
    "bme-setting-region-scoped-objective-enabled",
    (checked) => {
      _patchSettings({ enableRegionScopedObjective: checked });
    },
  );
  bindCheckbox("bme-setting-cognitive-memory-enabled", (checked) => {
    _patchSettings({ enableCognitiveMemory: checked });
  });
  bindCheckbox("bme-setting-spatial-adjacency-enabled", (checked) => {
    _patchSettings({ enableSpatialAdjacency: checked });
  });
  bindCheckbox("bme-setting-enable-story-timeline", (checked) => {
    _patchSettings({ enableStoryTimeline: checked });
  });
  bindCheckbox("bme-setting-story-time-soft-directing", (checked) => {
    _patchSettings({ storyTimeSoftDirecting: checked });
  });
  bindCheckbox("bme-setting-inject-story-time-label", (checked) => {
    _patchSettings({ injectStoryTimeLabel: checked });
  });
  bindCheckbox("bme-setting-inject-user-pov-memory", (checked) => {
    _patchSettings({ injectUserPovMemory: checked });
  });
  bindCheckbox("bme-setting-inject-objective-global-memory", (checked) => {
    _patchSettings({ injectObjectiveGlobalMemory: checked });
  });
  bindCheckbox("bme-setting-inject-low-confidence-objective-memory", (checked) => {
    _patchSettings({ injectLowConfidenceObjectiveMemory: checked });
  });
  bindCheckbox("bme-setting-consolidation-enabled", (checked) => {
    _patchSettings({ enableConsolidation: checked });
    _refreshGuardedConfigStates();
  });
  bindCheckbox("bme-setting-synopsis-enabled", (checked) => {
    _patchSettings({
      enableHierarchicalSummary: checked,
      enableSynopsis: checked,
    });
    _refreshGuardedConfigStates();
  });
  bindCheckbox("bme-setting-visibility-enabled", (checked) =>
    _patchSettings({ enableVisibility: checked }),
  );
  bindCheckbox("bme-setting-cross-recall-enabled", (checked) =>
    _patchSettings({ enableCrossRecall: checked }),
  );
  bindCheckbox("bme-setting-smart-trigger-enabled", (checked) => {
    _patchSettings({ enableSmartTrigger: checked });
    _refreshGuardedConfigStates();
  });
  bindCheckbox("bme-setting-sleep-cycle-enabled", (checked) => {
    _patchSettings({ enableSleepCycle: checked });
    _refreshGuardedConfigStates();
  });
  bindCheckbox("bme-setting-auto-compression-enabled", (checked) => {
    _patchSettings({ enableAutoCompression: checked });
    _refreshGuardedConfigStates();
  });
  bindCheckbox("bme-setting-prob-recall-enabled", (checked) => {
    _patchSettings({ enableProbRecall: checked });
    _refreshGuardedConfigStates();
  });
  bindCheckbox("bme-setting-reflection-enabled", (checked) => {
    _patchSettings({ enableReflection: checked });
    _refreshGuardedConfigStates();
  });
  const recallCardUserInputDisplayModeEl = document.getElementById(
    "bme-setting-recall-card-user-input-display-mode",
  );
  if (
    recallCardUserInputDisplayModeEl &&
    recallCardUserInputDisplayModeEl.dataset.bmeBound !== "true"
  ) {
    recallCardUserInputDisplayModeEl.addEventListener("change", () => {
      _patchSettings({
        recallCardUserInputDisplayMode:
          recallCardUserInputDisplayModeEl.value || "beautify_only",
      });
    });
    recallCardUserInputDisplayModeEl.dataset.bmeBound = "true";
  }
  const noticeDisplayModeEl = document.getElementById(
    "bme-setting-notice-display-mode",
  );
  if (noticeDisplayModeEl && noticeDisplayModeEl.dataset.bmeBound !== "true") {
    noticeDisplayModeEl.addEventListener("change", () => {
      _patchSettings({
        noticeDisplayMode: noticeDisplayModeEl.value || "normal",
      });
    });
    noticeDisplayModeEl.dataset.bmeBound = "true";
  }
  const cloudStorageModeEl = document.getElementById(
    "bme-setting-cloud-storage-mode",
  );
  if (cloudStorageModeEl && cloudStorageModeEl.dataset.bmeBound !== "true") {
    cloudStorageModeEl.addEventListener("change", () => {
      const settings = _patchSettings({
        cloudStorageMode: cloudStorageModeEl.value || "automatic",
      });
      _refreshCloudStorageModeUi(settings);
    });
    cloudStorageModeEl.dataset.bmeBound = "true";
  }
  const wiFilterModeEl = document.getElementById("bme-setting-wi-filter-mode");
  if (wiFilterModeEl && wiFilterModeEl.dataset.bmeBound !== "true") {
    wiFilterModeEl.addEventListener("change", () => {
      const nextValue = wiFilterModeEl.value || "default";
      _patchSettings({ worldInfoFilterMode: nextValue });
      const section = panelEl?.querySelector("#bme-wi-filter-custom-section");
      if (section) {
        section.style.display = nextValue === "custom" ? "" : "none";
      }
    });
    wiFilterModeEl.dataset.bmeBound = "true";
  }
  const wiFilterKeywordsEl = document.getElementById(
    "bme-setting-wi-filter-keywords",
  );
  if (wiFilterKeywordsEl && wiFilterKeywordsEl.dataset.bmeBound !== "true") {
    wiFilterKeywordsEl.addEventListener("change", () => {
      _patchSettings({
        worldInfoFilterCustomKeywords: wiFilterKeywordsEl.value || "",
      });
    });
    wiFilterKeywordsEl.dataset.bmeBound = "true";
  }

  bindNumber("bme-setting-extract-every", 1, 1, 50, (value) =>
    _patchSettings({ extractEvery: value }),
  );
  bindNumber(
    "bme-setting-hide-old-messages-keep-last-n",
    12,
    0,
    200,
    (value) => _patchSettings({ hideOldMessagesKeepLastN: value }),
  );
  bindNumber("bme-setting-extract-context-turns", 2, 0, 20, (value) =>
    _patchSettings({ extractContextTurns: value }),
  );
  bindCheckbox(
    "bme-setting-extract-auto-delay-latest-assistant",
    (checked) =>
      _patchSettings({ extractAutoDelayLatestAssistant: checked }),
  );
  bindNumber("bme-setting-recall-top-k", 20, 1, 100, (value) =>
    _patchSettings({ recallTopK: value }),
  );
  bindNumber("bme-setting-recall-max-nodes", 8, 1, 50, (value) =>
    _patchSettings({ recallMaxNodes: value }),
  );
  bindNumber("bme-setting-recall-diffusion-top-k", 100, 1, 300, (value) =>
    _patchSettings({ recallDiffusionTopK: value }),
  );
  bindNumber("bme-setting-recall-llm-candidate-pool", 30, 1, 100, (value) =>
    _patchSettings({ recallLlmCandidatePool: value }),
  );
  bindNumber("bme-setting-recall-llm-context-messages", 4, 0, 20, (value) =>
    _patchSettings({ recallLlmContextMessages: value }),
  );
  bindNumber(
    "bme-setting-recall-multi-intent-max-segments",
    4,
    1,
    8,
    (value) => _patchSettings({ recallMultiIntentMaxSegments: value }),
  );
  bindFloat(
    "bme-setting-recall-context-assistant-weight",
    0.2,
    0,
    1,
    (value) => _patchSettings({ recallContextAssistantWeight: value }),
  );
  bindFloat(
    "bme-setting-recall-context-previous-user-weight",
    0.1,
    0,
    1,
    (value) => _patchSettings({ recallContextPreviousUserWeight: value }),
  );
  bindFloat("bme-setting-recall-lexical-weight", 0.18, 0, 1, (value) =>
    _patchSettings({ recallLexicalWeight: value }),
  );
  bindFloat("bme-setting-recall-teleport-alpha", 0.15, 0, 1, (value) =>
    _patchSettings({ recallTeleportAlpha: value }),
  );
  bindFloat(
    "bme-setting-recall-temporal-link-strength",
    0.2,
    0,
    1,
    (value) => _patchSettings({ recallTemporalLinkStrength: value }),
  );
  bindNumber(
    "bme-setting-recall-dpp-candidate-multiplier",
    3,
    1,
    10,
    (value) => _patchSettings({ recallDppCandidateMultiplier: value }),
  );
  bindFloat("bme-setting-recall-dpp-quality-weight", 1.0, 0, 10, (value) =>
    _patchSettings({ recallDppQualityWeight: value }),
  );
  bindFloat("bme-setting-recall-cooccurrence-scale", 0.1, 0, 10, (value) =>
    _patchSettings({ recallCooccurrenceScale: value }),
  );
  bindNumber(
    "bme-setting-recall-cooccurrence-max-neighbors",
    10,
    1,
    50,
    (value) => _patchSettings({ recallCooccurrenceMaxNeighbors: value }),
  );
  bindNumber(
    "bme-setting-recall-residual-basis-max-nodes",
    24,
    2,
    64,
    (value) => _patchSettings({ recallResidualBasisMaxNodes: value }),
  );
  bindNumber("bme-setting-recall-nmf-topics", 15, 2, 64, (value) =>
    _patchSettings({ recallNmfTopics: value }),
  );
  bindFloat(
    "bme-setting-recall-nmf-novelty-threshold",
    0.4,
    0,
    1,
    (value) => _patchSettings({ recallNmfNoveltyThreshold: value }),
  );
  bindFloat("bme-setting-recall-residual-threshold", 0.3, 0, 10, (value) =>
    _patchSettings({ recallResidualThreshold: value }),
  );
  bindNumber("bme-setting-recall-residual-top-k", 5, 1, 20, (value) =>
    _patchSettings({ recallResidualTopK: value }),
  );
  bindFloat("bme-setting-recall-character-pov-weight", 1.25, 0, 3, (value) =>
    _patchSettings({ recallCharacterPovWeight: value }),
  );
  bindFloat("bme-setting-recall-user-pov-weight", 1.05, 0, 3, (value) =>
    _patchSettings({ recallUserPovWeight: value }),
  );
  bindFloat(
    "bme-setting-recall-objective-current-region-weight",
    1.15,
    0,
    3,
    (value) => _patchSettings({ recallObjectiveCurrentRegionWeight: value }),
  );
  bindFloat(
    "bme-setting-recall-objective-adjacent-region-weight",
    0.9,
    0,
    3,
    (value) => _patchSettings({ recallObjectiveAdjacentRegionWeight: value }),
  );
  bindFloat(
    "bme-setting-recall-objective-global-weight",
    0.75,
    0,
    3,
    (value) => _patchSettings({ recallObjectiveGlobalWeight: value }),
  );
  bindNumber("bme-setting-inject-depth", 9999, 0, 9999, (value) =>
    _patchSettings({ injectDepth: value }),
  );
  bindFloat("bme-setting-graph-weight", 0.6, 0, 1, (value) =>
    _patchSettings({ graphWeight: value }),
  );
  bindFloat("bme-setting-vector-weight", 0.3, 0, 1, (value) =>
    _patchSettings({ vectorWeight: value }),
  );
  bindFloat("bme-setting-importance-weight", 0.1, 0, 1, (value) =>
    _patchSettings({ importanceWeight: value }),
  );
  bindNumber("bme-setting-consolidation-neighbor-count", 5, 1, 20, (value) =>
    _patchSettings({ consolidationNeighborCount: value }),
  );
  bindFloat("bme-setting-consolidation-threshold", 0.85, 0.5, 0.99, (value) =>
    _patchSettings({ consolidationThreshold: value }),
  );
  bindNumber("bme-setting-synopsis-every", 3, 1, 100, (value) =>
    _patchSettings({
      smallSummaryEveryNExtractions: value,
      synopsisEveryN: value,
    }),
  );
  bindText("bme-setting-trigger-patterns", (value) =>
    _patchSettings({ triggerPatterns: value }),
  );
  bindNumber("bme-setting-smart-trigger-threshold", 2, 1, 10, (value) =>
    _patchSettings({ smartTriggerThreshold: value }),
  );
  bindFloat("bme-setting-forget-threshold", 0.5, 0.1, 1, (value) =>
    _patchSettings({ forgetThreshold: value }),
  );
  bindNumber(
    "bme-setting-consolidation-auto-min-new-nodes",
    2,
    1,
    50,
    (value) => _patchSettings({ consolidationAutoMinNewNodes: value }),
  );
  bindNumber(
    "bme-setting-compression-every",
    10,
    0,
    500,
    (value) => _patchSettings({ compressionEveryN: value }),
  );
  bindNumber("bme-setting-sleep-every", 10, 1, 200, (value) =>
    _patchSettings({ sleepEveryN: value }),
  );
  bindFloat("bme-setting-prob-recall-chance", 0.15, 0.01, 0.5, (value) =>
    _patchSettings({ probRecallChance: value }),
  );
  bindNumber("bme-setting-reflect-every", 10, 1, 200, (value) =>
    _patchSettings({ reflectEveryN: value }),
  );

  const llmPresetSelect = document.getElementById("bme-llm-preset-select");
  if (llmPresetSelect && llmPresetSelect.dataset.bmeBound !== "true") {
    llmPresetSelect.addEventListener("change", () => {
      const selectedName = String(llmPresetSelect.value || "");
      if (!selectedName) {
        const currentActivePreset = String(
          (_getSettings?.() || {}).llmActivePreset || "",
        );
        if (currentActivePreset) {
          _patchSettings({ llmActivePreset: "" });
        }
        _syncLlmPresetControls("");
        return;
      }

      const settings = _normalizeLlmPresetSettings(_getSettings?.() || {});
      const preset = settings.llmPresets?.[selectedName];
      if (!preset) {
        _patchSettings({ llmActivePreset: "" }, { refreshTaskWorkspace: true });
        _populateLlmPresetSelect(settings.llmPresets || {}, "");
        _syncLlmPresetControls("");
        toastr.warning("闂傚倸鍊搁崐椋庢閿熺姴纾婚柛鏇ㄥ瀬閸ヮ剦鏁嬮柍褜鍓熼獮濠傗枎閹惧磭顓洪梺鎸庢濡嫰宕滈銏♀拺闁告稑锕ユ径鍕煕鎼搭喖浜濈紒妤冨枛閸┾偓妞ゆ巻鍋撴い鏇秮閹虫粓妫冨☉姘辩嵁闂備礁鎲＄缓鍧楀磿閹惰棄绠熺憸鐗堝笚閻撶喖骞栧ǎ顒€鐏柍顖涙礋閺屻劌顫濋鐘电槇闂侀€炲苯澧存い銏℃瀹曞ジ鎮㈤崨濠勫建闂備浇顕х换鎺楀磻閻樺弬娑㈠礋椤栨艾鎯為梺鍦劋椤ㄥ棝鎮￠弴銏＄厵闁绘垶锚閻忥箓鏌熼崗鐓庡缂佺粯鐩畷锝嗗緞鐏炶В鎷版俊銈囧Х閸嬫稓绮旈崼鏇炵劦妞ゆ帒锕︾粔闈浢瑰鍕煄妞ゃ倕瀚换婵堝枈濡椿娼戦梺鍓茬厛娴滎亪宕洪埀顒併亜閹哄棗浜剧紒鍓ц檸閸樻儳鈽夐悽绋跨劦?, "ST-BME");
        return;
      }

      _patchSettings({
        llmApiUrl: preset.llmApiUrl,
        llmApiKey: preset.llmApiKey,
        llmModel: preset.llmModel,
        llmActivePreset: selectedName,
      });
      _setInputValue("bme-setting-llm-url", preset.llmApiUrl);
      _setInputValue("bme-setting-llm-key", preset.llmApiKey);
      _setInputValue("bme-setting-llm-model", preset.llmModel);
      _clearFetchedLlmModels();
      _syncLlmPresetControls(selectedName);
    });
    llmPresetSelect.dataset.bmeBound = "true";
  }

  const llmPresetSaveBtn = document.getElementById("bme-llm-preset-save");
  if (llmPresetSaveBtn && llmPresetSaveBtn.dataset.bmeBound !== "true") {
    llmPresetSaveBtn.addEventListener("click", () => {
      const settings = _normalizeLlmPresetSettings(_getSettings?.() || {});
      const activePreset = String(settings.llmActivePreset || "");
      if (!activePreset) {
        document.getElementById("bme-llm-preset-save-as")?.click();
        return;
      }

      const nextPresets = {
        ...(settings.llmPresets || {}),
        [activePreset]: _getLlmConfigInputSnapshot(),
      };
      _patchSettings({ llmPresets: nextPresets }, { refreshTaskWorkspace: true });
      _populateLlmPresetSelect(nextPresets, activePreset);
      _syncLlmPresetControls(activePreset);
      toastr.success("闂備浇宕甸崰鎰垝鎼淬垺娅犳俊銈呮噹缁犱即鏌涘☉姗堟敾婵炲懐濞€閺岋絽螣閸濆嫭顥濋梺缁樻⒒閸樠囨倿濞差亝鐓曢柟鑸妽濞呭洭鏌涢幋顖滅瘈闁诡喗顨堥幉鎾礋椤撶喐鍟撻柣搴㈩問閸犳骞愭ィ鍐ㄧ闁靛繒濯鈺呮煙閸忓摜顦﹀ù?, "ST-BME");
    });
    llmPresetSaveBtn.dataset.bmeBound = "true";
  }

  const llmPresetSaveAsBtn = document.getElementById("bme-llm-preset-save-as");
  if (llmPresetSaveAsBtn && llmPresetSaveAsBtn.dataset.bmeBound !== "true") {
    llmPresetSaveAsBtn.addEventListener("click", () => {
      const settings = _normalizeLlmPresetSettings(_getSettings?.() || {});
      const activePreset = String(settings.llmActivePreset || "");
      const suggestedName = activePreset
        ? `${activePreset} 闂傚倸鍊风粈渚€骞夐敓鐘茬闁冲搫鎳庨崹鍌炴煕濡ゅ啫鍓抽柤鏉挎健閺?
        : "闂傚倸鍊风粈渚€骞栭锕€纾圭紓浣股戝▍鐘充繆閵堝懎顏╅柡鍡欏仱濮?;
      const nextName = window.prompt("闂傚倷娴囧畷鍨叏閺夋嚚娲Ω閳轰浇鎽曟繝銏ｆ硾閺堫剟顢曢懞銉ｄ簻闁规儳宕悘鈺冪磼閳ь剟宕掗悙瀵稿帾婵犮垼鍩栭惄顖氼瀶椤曗偓閺岋綁骞橀姘婵犵數濮烽。钘壩ｉ崨鏉戝瀭妞ゅ繐鐗嗙粈鍫熺節闂堟稒锛嶉柣鏂挎閹便劌顪冪拠韫闁诲氦顫夊ú蹇涘磿闁稁鏁囧┑鍌滎焾閻?, suggestedName);
      if (nextName == null) return;

      const trimmedName = String(nextName).trim();
      if (!trimmedName) {
        toastr.info("婵犵數濮烽。钘壩ｉ崨鏉戝瀭妞ゅ繐鐗嗙粈鍫熺節闂堟稒锛嶉柣鏂挎閹便劌顪冪拠韫闁诲氦顫夊ú蹇涘磿闁稁鏁囧┑鍌滎焾閻愬﹪鏌涢埄鍐噧濞寸媴濡囩槐鎺斺偓锝庝憾濡插憡銇勯幘鐐藉仮鐎规洜鍘ч埞鎴﹀幢濡ゅ喚鍚呭┑鐘垫暩閸嬬偤宕归崼鏇炵濞达絿纭堕弸宥夋煥濠靛棭妲搁柣?, "ST-BME");
        return;
      }
      if (trimmedName in (settings.llmPresets || {})) {
        toastr.info("婵犵數濮烽。钘壩ｉ崨鏉戝瀭妞ゅ繐鐗嗙粈鍫熺節闂堟稒锛嶉柣鏂挎閹便劌顪冪拠韫闁诲氦顫夊ú蹇涘磿闁稁鏁囧┑鍌滎焾閻愬﹪鏌涢埄鍐噧濞寸姵绮嶉妵鍕棘鐠恒劎顔掑Δ鐘靛仦閹瑰洭鐛幒妤€绫嶉柍褜鍓熼獮澶嬬附閸涘ň鎷洪梻鍌氱墐閺呮盯鎯佸鍫熺厽闁圭偓鍓氬Σ鐑樹繆閸欏濮囬柍瑙勫灴瀹曞ジ鎮㈡搴￠叡闂傚倸鍊风粈渚€鎮樺┑瀣垫晞闁告侗鍠楅崕鐔封攽閻樻彃鈧潧危閸儲鐓欑紓浣靛灩閻忕姴霉濠婂懎浜剧紒?, "ST-BME");
        return;
      }

      const nextPresets = {
        ...(settings.llmPresets || {}),
        [trimmedName]: _getLlmConfigInputSnapshot(),
      };
      _patchSettings({
        llmPresets: nextPresets,
        llmActivePreset: trimmedName,
      }, { refreshTaskWorkspace: true });
      _populateLlmPresetSelect(nextPresets, trimmedName);
      _syncLlmPresetControls(trimmedName);
      toastr.success("闂備浇顕уù鐑藉箠閹捐绠熼梽鍥Φ閹版澘绀冩い鎾寸矆濮规姊虹紒妯活梿闁靛棌鍋撻梺绋款儐閹告悂鍩ユ径濞炬瀺妞ゆ挴鈧厖姹楅梺鐟板槻缂嶅﹪骞冮姀銈嗗亗閹兼番鍩勫Λ鐔兼⒒娴ｈ櫣甯涙い銊ユ嚇閹繝顢楁担铏规嚌闂侀€炲苯澧い?, "ST-BME");
    });
    llmPresetSaveAsBtn.dataset.bmeBound = "true";
  }

  const llmPresetDeleteBtn = document.getElementById("bme-llm-preset-delete");
  if (llmPresetDeleteBtn && llmPresetDeleteBtn.dataset.bmeBound !== "true") {
    llmPresetDeleteBtn.addEventListener("click", () => {
      const settings = _normalizeLlmPresetSettings(_getSettings?.() || {});
      const activePreset = String(settings.llmActivePreset || "");
      if (!activePreset) {
        toastr.info("闂備浇宕甸崰鎰垝鎼淬垺娅犳俊銈呮噹缁犱即鏌涘☉姗堟敾婵炲懐濞€閺岋絽螣閸濆嫭姣愮紓浣稿閸嬨倝寮诲☉銏犲嵆闁靛鍊楅弫鏍⒑閻撳海绉虹紒鐘崇墵瀵鎮㈤崗纰辨濠电偞鍨靛畷顒勫礈閻楀牏绡€婵炲牆鐏濋弸鎾绘煛閸涱喚顬奸柣蹇斿浮濮婃椽鎮欓挊澶婂缂佸墽铏庨崢鎯р槈閻㈢鐒垫い鎺戝閳锋垿鏌熺粙鎸庢崳闁宠棄顦甸弻锟犲醇椤愩垹鈷嬮梺璇″灙閸嬫捇姊洪崨濠勨姇婵炲吋鐟ч埀顒佽壘椤︻垶鈥︾捄銊﹀磯闁绘碍娼欐导鎰版煟閻樿京鍔嶉柣鎿勭節瀵鈽夐姀鐘殿唺闂佸搫鍊哥花閬嶅几閸涱厸鏀介柣鎰级閸ｅ綊姊虹敮顔剧М妤犵偛妫濆畷姗€顢欓懖鈺婃Ч婵＄偑鍊栭崹褰掑窗瀹ュ洦顐芥慨姗嗗墻閸?, "ST-BME");
        return;
      }

      const confirmed = window.confirm(
        `缂傚倸鍊烽懗鍫曟惞鎼淬劌鐭楅幖娣妼缁愭鏌″搴″箺闁稿鏅犻弻娑㈠箻濡も偓鐎氼剟寮抽锝囩閺夊牆澧介幃鍏笺亜椤撶偟澧﹂柟顔斤耿閸╋繝宕ㄩ瑙勫闂備礁鎲″ú宥夊疾濞戙垹鐒垫い鎺嶈兌婢ф娊鏌涢悤浣哥仸婵﹥妞藉畷顐﹀礋閸倣锔剧磽娴ｉ潧濮傚ù婊冪埣瀹曟椽鍩€?{activePreset}闂傚倸鍊烽懗鍫曞磻閵娾晛纾块柤纰卞墯瀹曟煡鏌涘畝鈧崑娑氱不閺嶎偅鍠愰柡鍐ㄧ墕閺嬩胶鈧箍鍎遍ˇ浼村磻閸曨偒娓婚悗锝庝簼閹癸絽顫㈤崶顒佲拻濞达絽鎲￠崯鐐烘煙缁嬫寧鎲哥紒顔芥⒐椤︾増鎯旈姀鈺佷缓婵＄偑鍊栭幐鍫曞垂閸︻厾鐭嗛柛宀€鍋為悡蹇擃熆閼哥數鈽夐柣锔界矒閺岋繝鍩€椤掑嫭鐒肩€广儱妫岄幏娲⒑閸︻厾甯涢悽顖滃仱閹ɑ娼忛妸褏顔曢梺鍓插亞閸犲酣鎮樼€电硶鍋撶憴鍕闁告梹鐟ラ～蹇涙嚒閵堝倸浜鹃梻鍫熺⊕閹叉悂鏌ｅ☉鏍у姕缂佺粯鐩弫鎰板川椤旂⒈妲辩紓鍌欐祰椤曆呪偓姘緲椤曪綁骞庨挊澶屽姦濡炪倖甯掔€氼參鎮¤箛娑欑厱闁斥晛鍟粈鍫㈢磼?
      );
      if (!confirmed) return;

      const nextPresets = { ...(settings.llmPresets || {}) };
      delete nextPresets[activePreset];
      _patchSettings({
        llmPresets: nextPresets,
        llmActivePreset: "",
      }, { refreshTaskWorkspace: true });
      _populateLlmPresetSelect(nextPresets, "");
      _syncLlmPresetControls("");
      toastr.success("婵犵數濮烽。钘壩ｉ崨鏉戝瀭妞ゅ繐鐗嗙粈鍫熺節闂堟稒锛嶉柣鏂挎娣囧﹪顢涘▎鎺濆妳闂佸摜鍠庨幊姗€寮婚悢铏圭＜婵☆垵娅ｉ悷銊╂⒑鐠囪尙绠氶柡鍛Т椤?, "ST-BME");
    });
    llmPresetDeleteBtn.dataset.bmeBound = "true";
  }

  bindText("bme-setting-llm-url", (value) => {
    _patchSettings({ llmApiUrl: value.trim() });
    _markLlmPresetDirty({ clearFetchedModels: true });
  });
  bindText("bme-setting-llm-key", (value) => {
    _patchSettings({ llmApiKey: value.trim() });
    _markLlmPresetDirty({ clearFetchedModels: true });
  });
  bindText("bme-setting-llm-model", (value) => {
    _patchSettings({ llmModel: value.trim() });
    _markLlmPresetDirty();
  });
  bindNumber("bme-setting-timeout-ms", 300000, 1000, 3600000, (value) =>
    _patchSettings({ timeoutMs: value }),
  );

  bindText("bme-setting-embed-url", (value) =>
    _patchSettings({ embeddingApiUrl: value.trim() }),
  );
  bindText("bme-setting-embed-key", (value) =>
    _patchSettings({ embeddingApiKey: value.trim() }),
  );
  bindText("bme-setting-embed-model", (value) =>
    _patchSettings({ embeddingModel: value.trim() }),
  );
  bindText("bme-setting-embed-mode", (value) => {
    _patchSettings({ embeddingTransportMode: value });
    _toggleEmbedFields(value);
  });
  bindText("bme-setting-embed-backend-source", (value) => {
    const settings = _getSettings?.() || {};
    const patch = { embeddingBackendSource: value };
    const suggestedModel = getSuggestedBackendModel(value);
    if (
      !settings.embeddingBackendModel ||
      settings.embeddingBackendModel ===
        getSuggestedBackendModel(settings.embeddingBackendSource || "openai")
    ) {
      patch.embeddingBackendModel = suggestedModel;
    }
    _patchSettings(patch);
    _setInputValue(
      "bme-setting-embed-backend-model",
      patch.embeddingBackendModel || settings.embeddingBackendModel || "",
    );
  });
  bindText("bme-setting-embed-backend-model", (value) =>
    _patchSettings({ embeddingBackendModel: value.trim() }),
  );
  bindText("bme-setting-embed-backend-url", (value) =>
    _patchSettings({ embeddingBackendApiUrl: value.trim() }),
  );
  bindCheckbox("bme-setting-embed-auto-suffix", (checked) =>
    _patchSettings({ embeddingAutoSuffix: checked }),
  );

  bindPromptText("bme-setting-extract-prompt", "extractPrompt", "extract");
  bindPromptText("bme-setting-recall-prompt", "recallPrompt", "recall");
  bindPromptText(
    "bme-setting-consolidation-prompt",
    "consolidationPrompt",
    "consolidation",
  );
  bindPromptText("bme-setting-compress-prompt", "compressPrompt", "compress");
  bindPromptText("bme-setting-synopsis-prompt", "synopsisPrompt", "synopsis");
  bindPromptText(
    "bme-setting-reflection-prompt",
    "reflectionPrompt",
    "reflection",
  );
  _bindTaskProfileWorkspace();

  panelEl.querySelectorAll(".bme-prompt-reset").forEach((button) => {
    if (button.dataset.bmeBound === "true") return;
    button.addEventListener("click", () => {
      const settingKey = button.dataset.settingKey;
      const promptKey = button.dataset.defaultPrompt;
      const targetId = button.dataset.targetId;
      if (!settingKey || !promptKey || !targetId) return;
      _patchSettings({ [settingKey]: "" }, { refreshPrompts: true });
      _setInputValue(targetId, getDefaultPromptText(promptKey));
      _refreshPromptCardStates();
    });
    button.dataset.bmeBound = "true";
  });

  const pickerBtn = document.getElementById("bme-theme-picker-btn");
  const dropdown = document.getElementById("bme-theme-dropdown");
  if (pickerBtn && dropdown) {
    pickerBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      dropdown.classList.toggle("open");
    });
    dropdown.querySelectorAll(".bme-theme-option").forEach((opt) => {
      opt.addEventListener("click", () => {
        const theme = opt.dataset.theme;
        if (!theme) return;
        _patchSettings({ panelTheme: theme }, { refreshTheme: true });
        dropdown.classList.remove("open");
      });
    });
    document.addEventListener("click", () => {
      dropdown.classList.remove("open");
    });
    dropdown.addEventListener("click", (e) => e.stopPropagation());
  }

  panelEl.querySelectorAll(".bme-theme-card").forEach((card) => {
    if (card.dataset.bmeBound === "true") return;
    card.addEventListener("click", () => {
      const theme = card.dataset.theme;
      if (!theme) return;
      _patchSettings({ panelTheme: theme }, { refreshTheme: true });
    });
    card.dataset.bmeBound = "true";
  });

  document
    .getElementById("bme-apply-hide-settings")
    ?.addEventListener("click", async () => {
      const result = await _actionHandlers.applyCurrentHide?.();
      if (result?.error) {
        toastr.error(result.error, "ST-BME");
        return;
      }
      toastr.success("闂備浇宕甸崰鎰垝鎼淬垺娅犳俊銈呮噹缁犱即鏌涘☉姗堟敾婵炲懐濞€閺岋絽螣閼测晛绗￠梺鎼炲€曢崐鎼佸煘閹达附鍋愰柟缁樺坊閸嬫捇鎳滈悽娈挎锤濡炪倖鐗滈崑鐐烘偂閻斿吋鐓忓┑鐐茬仢閸旀碍銇勮箛锝呭箺缂佺粯鐩畷濂割敆閸屾簽婊堟⒑閸︻収鐒鹃柨鏇樺妿缁鈽夊鍡樺兊闂佺粯鎸哥€涒晛鈻嶅Δ鍐＝闁稿本鑹鹃埀顒佹倐瀹曟澘顫濈捄铏圭崶闂佸搫绋侀崢鑲╃矆閸曨垱鐓ラ柣鏂挎惈鏍￠梺缁樻尭閸婂鍩€椤掆偓缁犲秹宕曢崡鐐嶆稑鈻庨幘鏉戜簵闂侀€炲苯澧撮柡宀€鍠栭幃鈩冩償閿濆棙鍠栨繝娈垮枛閿曘倝鈥﹀畡閭﹀殨?, "ST-BME");
    });
  document
    .getElementById("bme-clear-hide-settings")
    ?.addEventListener("click", async () => {
      const result = await _actionHandlers.clearCurrentHide?.();
      if (result?.error) {
        toastr.error(result.error, "ST-BME");
        return;
      }
      toastr.info("闂備浇顕уù鐑藉箠閹捐绠熼梽鍥Φ閹版澘绀冩い鎾寸矆濮规姊洪幖鐐插妧闁逞屽墮鍗遍柛顐犲劜閻撴洘銇勯幇鍓佹偧缂佺姵顭囩槐鎺撳緞婵炲灝浠梺鍝勬湰閻╊垶鐛Ο铏规殾闁搞儱妫庨崕閬嶆箒濠电姴锕ら幊搴ㄣ€傞懖鈹惧亾閸偅绶查悗姘嵆瀹曟椽鏁撻悩鎻掔獩濡炪倖鎸鹃崳銉︾閿曞倹鈷?ST-BME 闂傚倷绀佸﹢閬嶅储瑜旈幃娲Ω閵夘喗缍庢繝鐢靛У閼归箖寮告笟鈧弻鏇㈠醇濠垫劖效闂佺楠哥粔褰掑蓟濞戙垹鍗抽柕濞垮劤娴狀厼顪冮妶鍡樺鞍婵＄偘绮欏?, "ST-BME");
    });
  document
    .getElementById("bme-test-llm")
    ?.addEventListener("click", async () => {
      await _actionHandlers.testMemoryLLM?.();
    });
  document
    .getElementById("bme-test-embedding")
    ?.addEventListener("click", async () => {
      await _actionHandlers.testEmbedding?.();
    });
  document
    .getElementById("bme-fetch-llm-models")
    ?.addEventListener("click", async () => {
      const result = await _actionHandlers.fetchMemoryLLMModels?.();
      if (!result?.success) return;
      fetchedMemoryLLMModels = result.models || [];
      _renderFetchedModelOptions(
        "bme-select-llm-model",
        fetchedMemoryLLMModels,
        (_getSettings?.() || {}).llmModel || "",
      );
    });
  document
    .getElementById("bme-fetch-embed-backend-models")
    ?.addEventListener("click", async () => {
      const result = await _actionHandlers.fetchEmbeddingModels?.("backend");
      if (!result?.success) return;
      fetchedBackendEmbeddingModels = result.models || [];
      _renderFetchedModelOptions(
        "bme-select-embed-backend-model",
        fetchedBackendEmbeddingModels,
        (_getSettings?.() || {}).embeddingBackendModel || "",
      );
    });
  document
    .getElementById("bme-fetch-embed-direct-models")
    ?.addEventListener("click", async () => {
      const result = await _actionHandlers.fetchEmbeddingModels?.("direct");
      if (!result?.success) return;
      fetchedDirectEmbeddingModels = result.models || [];
      _renderFetchedModelOptions(
        "bme-select-embed-direct-model",
        fetchedDirectEmbeddingModels,
        (_getSettings?.() || {}).embeddingModel || "",
      );
    });

  bindSelectModel("bme-select-llm-model", "bme-setting-llm-model", "llmModel");
  bindSelectModel(
    "bme-select-embed-backend-model",
    "bme-setting-embed-backend-model",
    "embeddingBackendModel",
  );
  bindSelectModel(
    "bme-select-embed-direct-model",
    "bme-setting-embed-model",
    "embeddingModel",
  );

  panelEl.dataset.bmeConfigBound = "true";
}

function bindText(id, onChange) {
  const element = document.getElementById(id);
  if (!element || element.dataset.bmeBound === "true") return;
  element.addEventListener("input", () => onChange(element.value));
  element.addEventListener("change", () => onChange(element.value));
  element.dataset.bmeBound = "true";
}

function bindCheckbox(id, onChange) {
  const element = document.getElementById(id);
  if (!element || element.dataset.bmeBound === "true") return;
  element.addEventListener("change", () => onChange(Boolean(element.checked)));
  element.dataset.bmeBound = "true";
}

function bindNumber(id, fallback, min, max, onChange) {
  const element = document.getElementById(id);
  if (!element || element.dataset.bmeBound === "true") return;
  element.addEventListener("input", () => {
    let value = Number.parseInt(element.value, 10);
    if (!Number.isFinite(value)) value = fallback;
    value = Math.min(max, Math.max(min, value));
    onChange(value);
  });
  element.dataset.bmeBound = "true";
}

function bindFloat(id, fallback, min, max, onChange) {
  const element = document.getElementById(id);
  if (!element || element.dataset.bmeBound === "true") return;
  element.addEventListener("input", () => {
    let value = Number.parseFloat(element.value);
    if (!Number.isFinite(value)) value = fallback;
    value = Math.min(max, Math.max(min, value));
    onChange(value);
  });
  element.dataset.bmeBound = "true";
}

function bindPromptText(id, settingKey, promptKey) {
  const element = document.getElementById(id);
  if (!element || element.dataset.bmeBound === "true") return;
  const update = () => {
    _patchSettings({ [settingKey]: element.value }, { refreshPrompts: true });
  };
  element.addEventListener("input", update);
  element.addEventListener("change", update);
  element.addEventListener("blur", () => {
    if (!String(element.value || "").trim()) {
      _setInputValue(id, getDefaultPromptText(promptKey));
    }
  });
  element.dataset.bmeBound = "true";
}

function bindSelectModel(selectId, inputId, settingKey) {
  const element = document.getElementById(selectId);
  if (!element || element.dataset.bmeBound === "true") return;
  element.addEventListener("change", () => {
    if (!element.value) return;
    _setInputValue(inputId, element.value);
    _patchSettings({ [settingKey]: element.value });
  });
  element.dataset.bmeBound = "true";
}

function _bindTaskProfileWorkspace() {
  const workspace = document.getElementById("bme-task-profile-workspace");
  const importInput = document.getElementById("bme-task-profile-import");
  if (!workspace) return;

  if (workspace.dataset.bmeBound !== "true") {
    workspace.addEventListener("click", (event) => {
      void _handleTaskProfileWorkspaceClick(event);
    });
    workspace.addEventListener("input", (event) => {
      _handleTaskProfileWorkspaceInput(event);
    });
    workspace.addEventListener("change", (event) => {
      _handleTaskProfileWorkspaceChange(event);
    });
    workspace.addEventListener("dragstart", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const handle = target.closest(".bme-task-drag-handle");
      const row = target.closest(".bme-task-block-row");
      if (!handle || !(row instanceof HTMLElement)) return;
      const blockId = String(row.dataset.blockId || "").trim();
      if (!blockId) return;
      currentTaskProfileDragBlockId = blockId;
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.dropEffect = "move";
        event.dataTransfer.setData("text/plain", blockId);
      }
      window.requestAnimationFrame(() => {
        row.classList.add("dragging");
      });
    });
    workspace.addEventListener("dragover", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement) || !currentTaskProfileDragBlockId) return;
      const row = target.closest(".bme-task-block-row");
      if (!(row instanceof HTMLElement)) return;
      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = "move";
      }
      const position = _getTaskBlockDropPosition(row, event.clientY);
      _setTaskBlockDragIndicator(workspace, row, position);
    });
    workspace.addEventListener("dragleave", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const row = target.closest(".bme-task-block-row");
      if (!(row instanceof HTMLElement)) return;
      const relatedTarget = event.relatedTarget;
      if (relatedTarget instanceof Node && row.contains(relatedTarget)) {
        return;
      }
      row.classList.remove("drag-over-top", "drag-over-bottom");
    });
    workspace.addEventListener("drop", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const row = target.closest(".bme-task-block-row");
      if (!(row instanceof HTMLElement)) return;
      event.preventDefault();
      const sourceId =
        currentTaskProfileDragBlockId ||
        String(event.dataTransfer?.getData("text/plain") || "").trim();
      const targetId = String(row.dataset.blockId || "").trim();
      const position = _getTaskBlockDropPosition(row, event.clientY);
      _clearTaskBlockDragIndicators(workspace);
      currentTaskProfileDragBlockId = "";
      if (!sourceId || !targetId || sourceId === targetId) return;
      _reorderTaskBlocks(sourceId, targetId, position);
    });
    workspace.addEventListener("dragend", () => {
      currentTaskProfileDragBlockId = "";
      _clearTaskBlockDragIndicators(workspace);
    });
    workspace.addEventListener("dragstart", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const handle = target.closest(".bme-regex-drag-handle");
      const row = target.closest(".bme-regex-rule-row");
      if (!handle || !(row instanceof HTMLElement)) return;
      const ruleId = String(row.dataset.ruleId || "").trim();
      if (!ruleId) return;
      currentTaskProfileDragRuleId = ruleId;
      currentTaskProfileDragRuleIsGlobal = _isGlobalRegexPanelTarget(row);
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.dropEffect = "move";
        event.dataTransfer.setData("text/plain", ruleId);
      }
      window.requestAnimationFrame(() => {
        row.classList.add("dragging");
      });
    });
    workspace.addEventListener("dragover", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement) || !currentTaskProfileDragRuleId) return;
      const row = target.closest(".bme-regex-rule-row");
      if (!(row instanceof HTMLElement)) return;
      const isGlobalRow = _isGlobalRegexPanelTarget(row);
      if (isGlobalRow !== currentTaskProfileDragRuleIsGlobal) return;
      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = "move";
      }
      const position = _getRegexRuleDropPosition(row, event.clientY);
      _setRegexRuleDragIndicator(workspace, row, position);
    });
    workspace.addEventListener("dragleave", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const row = target.closest(".bme-regex-rule-row");
      if (!(row instanceof HTMLElement)) return;
      const relatedTarget = event.relatedTarget;
      if (relatedTarget instanceof Node && row.contains(relatedTarget)) {
        return;
      }
      row.classList.remove("drag-over-top", "drag-over-bottom");
    });
    workspace.addEventListener("drop", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const row = target.closest(".bme-regex-rule-row");
      if (!(row instanceof HTMLElement)) return;
      const isGlobalRow = _isGlobalRegexPanelTarget(row);
      if (isGlobalRow !== currentTaskProfileDragRuleIsGlobal) return;
      event.preventDefault();
      const sourceId =
        currentTaskProfileDragRuleId ||
        String(event.dataTransfer?.getData("text/plain") || "").trim();
      const targetId = String(row.dataset.ruleId || "").trim();
      const position = _getRegexRuleDropPosition(row, event.clientY);
      _clearRegexRuleDragIndicators(workspace);
      currentTaskProfileDragRuleId = "";
      currentTaskProfileDragRuleIsGlobal = false;
      if (!sourceId || !targetId || sourceId === targetId) return;
      _reorderRegexRules(sourceId, targetId, position, isGlobalRow);
    });
    workspace.addEventListener("dragend", () => {
      currentTaskProfileDragRuleId = "";
      currentTaskProfileDragRuleIsGlobal = false;
      _clearRegexRuleDragIndicators(workspace);
    });
    workspace.dataset.bmeBound = "true";
  }

  if (importInput && importInput.dataset.bmeBound !== "true") {
    importInput.addEventListener("change", async () => {
      const file = importInput.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const settings = _getSettings?.() || {};
        const parsed = JSON.parse(text);
        let nextGlobalTaskRegex = _normalizeGlobalRegexDraft(
          settings.globalTaskRegex || {},
        );
        const importedGlobalMerge = _mergeImportedGlobalRegex(
          nextGlobalTaskRegex,
          parsed?.globalTaskRegex,
        );
        nextGlobalTaskRegex = importedGlobalMerge.globalTaskRegex;
        let imported = parseImportedTaskProfile(
          settings.taskProfiles || {},
          parsed,
        );
        const legacyRuleMerge = _mergeProfileRegexRulesIntoGlobal(
          nextGlobalTaskRegex,
          imported.profile,
          {
            applyLegacyConfig: !importedGlobalMerge.replacedConfig,
          },
        );
        nextGlobalTaskRegex = legacyRuleMerge.globalTaskRegex;
        if (legacyRuleMerge.clearedLegacyRules) {
          imported = {
            ...imported,
            profile: legacyRuleMerge.profile,
            taskProfiles: upsertTaskProfile(
              imported.taskProfiles,
              imported.taskType,
              legacyRuleMerge.profile,
              { setActive: true },
            ),
          };
        }
        currentTaskProfileTaskType = imported.taskType || currentTaskProfileTaskType;
        currentTaskProfileBlockId = imported.profile?.blocks?.[0]?.id || "";
        currentTaskProfileRuleId =
          imported.profile?.regex?.localRules?.[0]?.id || "";
        _patchSettings(
          {
            taskProfilesVersion: 3,
            taskProfiles: imported.taskProfiles,
            globalTaskRegex: nextGlobalTaskRegex,
          },
          {
            refreshTaskWorkspace: true,
          },
        );
        const mergedRuleCount =
          importedGlobalMerge.mergedRuleCount + legacyRuleMerge.mergedRuleCount;
        toastr.success(
          mergedRuleCount > 0
            ? `濠电姷顣藉Σ鍛村磻閸涱収鐔嗘俊顖氱毞閸嬫挸顫濋悡搴ｄ桓濡炪們鍨洪悷鈺侇嚕閹绢喗鍋愭い鎰垫線婢规洟姊哄Ч鍥х伈婵炰匠鍛殰闁割偅娲橀悡鏇熺箾閸℃绠叉い銉ｅ灪椤ㄣ儵鎮欏顔煎壎濡ょ姷鍋涘ú顓€佸Δ鍛劦妞ゆ帒瀚哥紞鏍煟濡偐甯涢柣?{mergedRuleCount} 闂傚倸鍊风粈渚€骞栭位鍥敃閿曗偓缁€鍫熺節闂堟侗鍎涢柡浣告缁绘繃绻濋崒婊冾暫缂備讲鍋撻柛鈩冾焽缁犻箖鏌涢埄鍏狀亝绌遍娑氱闁稿繒鍘ф慨宥夋煛鐏炲墽娲存鐐村浮楠炴﹢鎳滈棃娑欑彛闂傚倷绀侀幉锟犲春婵犲嫭宕叉繝闈涙閺嗭箓鏌曟径鍡樻珔闂佸崬娲︾换婵嬫濞戝啿浼愰梺缁樼箥閸ㄨ泛顫忓ú顏勫窛濠电姴鍊婚悷鎰版⒑閸涘娈曞┑鐐诧躬瀹曟椽鍩€椤掍降浜滈柟鍝勭Ф閸斿秹鏌ｉ妸锕€鐏撮柡灞稿墲閹峰懘妫冨☉鎺戜壕闁哄浂婢佺紞鏍煏韫囧鈧牠寮查弻銉︾厱婵炴垵宕獮妯好归悩娆忔处閻撶喖鏌ｉ弬鎸庢喐闁瑰啿鍟撮幃妤€顫濋悡搴♀拫閻庤娲栫紞濠囧箚閳?
            : "濠电姷顣藉Σ鍛村磻閸涱収鐔嗘俊顖氱毞閸嬫挸顫濋悡搴ｄ桓濡炪們鍨洪悷鈺侇嚕閹绢喗鍋愭い鎰垫線婢规洟姊哄Ч鍥х伈婵炰匠鍛殰闁割偅娲橀悡鏇熺箾閸℃绠叉い銉ｅ灪椤ㄣ儵鎮欏顔煎壎濡ょ姷鍋涘ú顓€佸Δ鍛劦妞ゆ帒瀚哥紞?,
          "ST-BME",
        );
      } catch (error) {
        console.error("[ST-BME] 闂傚倷娴囬褍霉閻戣棄鏋侀柟闂寸閸屻劎鎲搁弬璺ㄦ殾闁挎繂顦獮銏′繆椤栨壕鎷℃繛鏉戝閺岋綁鎮╅崣澶婎槱閻熸粍婢橀崯鎾晲閻愬搫围闁告稑鍊归惄顖氼嚕閸洖鍨傛い鏇炴噸缁辨挻淇婇悙顏勨偓鏍ь潖閻熸噴鍝勎熸笟顖氭闂佸憡娲﹂崜姘辩礊閸ャ劊浜滈柟鎵虫櫅閸?", error);
        toastr.error(`濠电姷顣藉Σ鍛村磻閸涱収鐔嗘俊顖氱毞閸嬫挸顫濋悡搴ｄ桓濡炪們鍨洪悷鈺侇嚕閹绢喗鍋愭い鎰垫線婢规洟姊哄Ч鍥х伈婵炰匠鍛殰闁割偅娲橀悡鏇熺箾閸℃绠叉い銉у仧閳ь剙鐏氬妯尖偓姘煎幖椤洩绠涘☉杈ㄦ櫇闂? ${error?.message || error}`, "ST-BME");
      } finally {
        importInput.value = "";
      }
    });
    importInput.dataset.bmeBound = "true";
  }

  const importAllInput = document.getElementById("bme-task-profile-import-all");
  if (importAllInput && importAllInput.dataset.bmeBound !== "true") {
    importAllInput.addEventListener("change", async () => {
      const file = importAllInput.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const parsed = JSON.parse(text);
        if (parsed?.format !== "st-bme-all-task-profiles" || !parsed?.profiles) {
          throw new Error("闂傚倸鍊风粈渚€骞栭锕€纾圭紒瀣紩濞差亝鏅查柛娑变簼閻庡姊洪棃娑氱疄闁稿﹥娲熷畷姗€鍩€椤掑嫭鈷戠紓浣股戠亸顓熺箾閹绢噮妫戞繛鎴犳暬閸┾偓妞ゆ帊鑳剁粻楣冩煙鐎电浠﹂悘蹇ｅ幘缁辨帗寰勭仦鐐瘓濡炪們鍨洪〃鍛粹€﹂妸鈺佸窛妞ゆ梻鍘ч獮鎴炰繆閻愵亜鈧牕煤閺嶎灛娑樷槈濮樿京鐒兼繝銏ｅ煐閸旀牠宕戦敐澶嬬厱闁靛鍨哄▍鍛存煕濡粯灏﹂柡灞界Х椤т線鏌涢幘瀵告噰閽樻繈鏌熷▓鍨灀闁稿鎸搁～婵嬪Ψ閵夈儺娼庡┑鐘殿暯閳ь剚鍓氶崵鐔访归悪鍛洭缂侇喚鏁搁埀顒婄秵娴滄繈顢欓幘缁樷拻濞达絽鎲￠崯鐐烘煕閵娧勬毈妤犵偞鐗犻、鏇㈡晝閳ь剟鎯屽Δ鍛彄闁搞儯鍔庨埊鏇㈡煟閹烘鐣洪柡灞炬礃缁绘繆绠涢弴鐐电厳闂備胶顭堥鍡涘箰閹间緡鏁囧┑鍌滎焾閻愬﹪鏌曟繝蹇涙妞ゅ繒鍠栧缁樻媴閻戞ê娈岄梺瀹︽澘濮傜€规洘绻傝灃闁逞屽墴閸┿垽骞樼拠鑼吅闂佹寧娲嶉崑鎾翠繆椤愶綇鑰块柡灞剧洴婵＄兘顢涢悙鎼偓宥咁渻?);
        }
        const settings = _getSettings?.() || {};
        let mergedProfiles = settings.taskProfiles || {};
        let nextGlobalTaskRegex = _normalizeGlobalRegexDraft(
          settings.globalTaskRegex || {},
        );
        const importedGlobalMerge = _mergeImportedGlobalRegex(
          nextGlobalTaskRegex,
          parsed?.globalTaskRegex,
        );
        nextGlobalTaskRegex = importedGlobalMerge.globalTaskRegex;
        let importedCount = 0;
        let mergedLegacyRuleCount = 0;
        let legacyConfigImported = Boolean(importedGlobalMerge.replacedConfig);
        let skippedLegacyConfigCount = 0;
        for (const [taskType, entry] of Object.entries(parsed.profiles)) {
          try {
            let imported = parseImportedTaskProfile(
              mergedProfiles,
              entry,
              taskType,
            );
            const legacyRuleMerge = _mergeProfileRegexRulesIntoGlobal(
              nextGlobalTaskRegex,
              imported.profile,
              {
                applyLegacyConfig: !legacyConfigImported,
              },
            );
            nextGlobalTaskRegex = legacyRuleMerge.globalTaskRegex;
            mergedLegacyRuleCount += legacyRuleMerge.mergedRuleCount;
            if (legacyRuleMerge.appliedLegacyConfig) {
              legacyConfigImported = true;
            } else if (legacyRuleMerge.hasConfigDiff && legacyConfigImported) {
              skippedLegacyConfigCount += 1;
            }
            if (legacyRuleMerge.clearedLegacyRules) {
              imported = {
                ...imported,
                profile: legacyRuleMerge.profile,
                taskProfiles: upsertTaskProfile(
                  imported.taskProfiles,
                  imported.taskType,
                  legacyRuleMerge.profile,
                  { setActive: true },
                ),
              };
            }
            mergedProfiles = imported.taskProfiles;
            importedCount++;
          } catch (innerError) {
            console.warn(`[ST-BME] 闂傚倷娴囧畷鍨叏閹绢喖绠规い鎰堕檮閸嬵亪鏌涢妷銏℃珕鐎规洘鐓￠弻娑㈠箛閸忓摜鎸夐梺绋款儐閹瑰洭骞冩禒瀣棃婵炴垶眉缁垶姊绘担鍛婂暈闁荤喆鍎辫灋婵炲棙鍨归惌澶愭煙閻戞ɑ鈷愰悗姘哺閺岀喓绱掑Ο杞板垔濠?${taskType}:`, innerError);
          }
        }
        if (importedCount === 0) {
          toastr.warning("婵犵數濮烽弫鎼佸磻濞戞瑥绶為柛銉墮缁€鍫熺節闂堟稒锛旈柤鏉跨仢閵嗘帒顫濋敐鍛婵°倗濮烽崑娑㈩敄婢舵劗宓侀柛銉墻閺佸棝鏌嶈閸撶喖鏁愰悙鐑樺亹缂備焦锚閳ь剛鏁婚弻锝夊閵堝棙閿柣銏╁灠閻栧ジ寮诲☉妯锋瀻闊洦妫忓Λ锛勭磽娴ｇ鈧湱鏁悙鍝勭閻庯綆浜為弳锕傛煕閵夈垺鏆曟い鎾跺枍缁诲棙銇勯幇鍓佺ɑ缂佽埖鐓￠幃妤€顫濋悡搴ｄ桓濡?, "ST-BME");
          return;
        }
        _patchSettings(
          {
            taskProfilesVersion: 3,
            taskProfiles: mergedProfiles,
            globalTaskRegex: nextGlobalTaskRegex,
          },
          {
            refreshTaskWorkspace: true,
          },
        );
        const mergedRuleCount =
          importedGlobalMerge.mergedRuleCount + mergedLegacyRuleCount;
        if (skippedLegacyConfigCount > 0) {
          console.warn(
            `[ST-BME] 闂傚倷娴囬褍霉閻戣棄鏋侀柟闂寸閸屻劎鎲搁弬璺ㄦ殾闁挎繂顦獮銏＄箾閹寸儐鐒芥い蟻鍥ㄢ拺闂傚牊鍗曢崼銉ョ柧婵炴垯鍨圭粈澶愭煏婢跺棙娅嗛柣鎾寸洴閺屾盯骞囬鈧鈺呮煙閸愭煡鍙勯柕鍡楀€块幃锟犵嵁椤掍胶娲寸€殿喖鐖煎畷褰掝敋閸涱剛纾藉┑锛勫亼閸婃牕顫忛悷鎳婃椽鎮㈡總澶婃濡炪倖娲嶉崑鎾绘煙閾忣偆鐭婇柍缁樻崌楠炴劖鎯斿Ο璇茬槻婵犵數濮烽弫鎼佸磻閻愬樊鐒芥繛鍡樻惄閺佸嫰鏌涘☉娆愮稇闁?${skippedLegacyConfigCount} 濠电姷鏁搁崑娑㈩敋椤撶喐鍙忕€规洖娲ら崹婵囩箾閸℃ɑ濯伴柣鎴ｆ绾惧吋绻涢幋鐑嗙劷缂佹劗鍋ゅ娲传閸曨厸鏋岄梻鍌氬鐎氼剟鎮鹃悜钘夎摕闁靛濡囬崢閬嶆⒑閸濆嫬鏆為柟绋垮⒔婢规洟宕归銉︽閹晠宕ｆ径瀣€锋俊鐐€ら崑渚€宕规禒瀣瀬闁圭増婢樺婵囥亜閹捐泛小闁瑰鍏樺濠氬磼濞嗘垵濡藉┑鐘灪椤洨鍒掗弮鍫濋唶闁哄洨鍠庢禒楣冩⒑缁洖澧茬紒瀣灩缁牓宕橀鐣屽幘缂佺偓婢樺畷顒佹櫠閹殿喒鍋撶憴鍕闁告梹鐟╁濠氬Ω閵夈垺顫嶅┑鈽嗗灠閻忔繈顢旈銏♀拺闁告稑锕ら悘宥夋煕閹惧绠樼紒顔藉哺瀹曪繝鎮欓埡鍌涙澑闂備礁澹婇崑鍡涘窗閹扮増鍋╂い鎺戝€荤壕钘壝归敐鍫殐婵炲牄鍨介弻娑滅疀閺冨倶鈧帞绱掗瑙勬珖闁逞屽墯缁嬫帡鈥﹂崶顑锯偓鍛存倻閼恒儳鍘辨繝鐢靛Т鐎氼剟寮搁弮鍫熷仯濞撴艾锕﹂幃鑲╃磼鏉堛劌绗氱€垫澘瀚幆鏃堫敊閸忕⒈鍞查梻鍌欒兌绾爼寮插☉銏″剹闁稿瞼鍋涢拑鐔兼煕濞戝崬寮炬繛灏栨櫊瀵爼宕煎☉妯侯瀴濠电偛鐗勯崹褰掑煘閹达富鏁婇柣锝呯灱椤斿洨绱撴担钘夌处缂侇喗鐟ラ悾鐤亹閹烘繃鏅梺缁樺姈濞兼瑩宕滈銏♀拺闁告稑锕ユ径鍕煕閵婏箑顥嬮柡渚囧枛閻ｇ兘宕堕埡鍐跨闯闂備礁鎲￠崝鏍磿閸愭祴鏋嶆繛鍡樺灩绾惧ジ寮堕崼娑樺缂佺姷鍋熼埀顒冾潐濞叉﹢銆冩繝鍌ゅ殨闁汇垹鎲￠崑銊╂煟閵忋埄鏆柡瀣箰閳规垿鎮欏顔兼婵犳鍠楅幐鎶界嵁婵犲啯鍎熼柕濞垮劤閻ｆ椽鏌熼崗鑲╂殬闁告柨楠搁悾鍨瑹閳ь剟寮婚悢纰辨晬闁绘劘寮撻崰濠傗攽閻愭彃鎮戦柛鏃€鐟╁璇测槈閵忕姷顔婇梺瑙勫礃閸╂牠宕抽敐澶嬧拺闂侇偆鍋涢懟顖炲储閸濄儳纾?
          );
        }
        toastr.success(
          mergedRuleCount > 0
            ? `闂備浇顕уù鐑藉箠閹捐绠熼梽鍥Φ閹版澘绀冩い鏇炴噺閺咁亪姊绘笟鍥у缂佸顕划?${importedCount} 濠电姷鏁搁崑鐐哄垂閸洖绠归柍鍝勫€婚々鍙夌箾閸℃ɑ灏紒鐘崇叀閺屾洝绠涚€ｎ亖鍋撻弴鐘电焼濠㈣埖鍔栭悡銉╂煟閺傛寧鎯堟い搴＄焸閺岋繝宕卞Ο鑽ゎ槹闂佽鍠涢～澶愬箯閸涱垱鍠嗛柛鏇ㄥ亞瑜把呯磽閸屾瑦绁板鏉戞憸閹广垽宕奸妷锕€浠掑銈嗘⒒閸嬫挸鐣锋径鎰厽闁瑰浼濋鍫濈劦妞ゆ垶鍎抽埀顒佺墵閵?${mergedRuleCount} 闂傚倸鍊风粈渚€骞栭尾銊╁焵椤掑倻纾肩紓浣诡焽缁犵偤鏌涢埞鎯т壕婵＄偑鍊栫敮濠囨倿閿曞倹鍎嶉柟杈鹃檮閻撴稑霉閿濆娑ч柍褜鍓氬ú鐔兼晲閻愬搫顫呴柕鍫濇濞呮粓姊洪崨濠佺繁闁告鍋撶粋鎺曨樄闁哄矉缍侀幃銏ゅ传閵夛箑娅戦梺璇插閸戝綊宕滈悢椋庢殾鐟滅増甯楅崕?
            : `闂備浇顕уù鐑藉箠閹捐绠熼梽鍥Φ閹版澘绀冩い鏇炴噺閺咁亪姊绘笟鍥у缂佸顕划?${importedCount} 濠电姷鏁搁崑鐐哄垂閸洖绠归柍鍝勫€婚々鍙夌箾閸℃ɑ灏紒鐘崇叀閺屾洝绠涚€ｎ亖鍋撻弴鐘电焼濠㈣埖鍔栭悡銉╂煟閺傛寧鎯堟い搴＄焸閺岋繝宕卞Ο鑽ゎ槹闂佽鍠涢～澶愬箯閸涘瓨鎯為悷娆忓濡?
          "ST-BME",
        );
      } catch (error) {
        console.error("[ST-BME] 闂傚倷娴囬褍霉閻戣棄鏋侀柟闂寸閸屻劎鎲搁弬璺ㄦ殾闁挎繂顦獮銏＄箾閹寸儐鐒芥い蟻鍥ㄢ拺闂傚牊鍗曢崼銉ョ柧婵炴垯鍨圭粈澶愭煏婢跺牆鍓绘繛鎴欏灩缁狙囨煕椤垵娅樺ù鐓庡€搁—鍐Χ閸℃ǚ鎷瑰┑鐐插级閿氭い鏇樺劦瀹曠喖顢楁担铏剐ゆ俊鐐€栭崝鎴﹀磿?", error);
        toastr.error(`闂傚倷娴囬褍霉閻戣棄鏋侀柟闂寸閸屻劎鎲搁弬璺ㄦ殾闁挎繂顦獮銏＄箾閹寸儐鐒芥い蟻鍥ㄢ拺闂傚牊鍗曢崼銉ョ柧婵炴垯鍨圭粈澶愭煏婢跺牆鍓绘繛鎴欏灩缁狙囨煕椤垵娅樺ù鐓庡€搁—鍐Χ閸℃ǚ鎷瑰┑鐐插级閿氭い鏇樺劦瀹曠喖顢楁担铏剐ゆ俊鐐€栭崝鎴﹀磿? ${error?.message || error}`, "ST-BME");
      } finally {
        importAllInput.value = "";
      }
    });
    importAllInput.dataset.bmeBound = "true";
  }
}

function _handleTaskProfileWorkspaceInput(event) {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const isGlobalRegexPanel = _isGlobalRegexPanelTarget(target);

  if (target.matches("[data-block-field]")) {
    _persistSelectedBlockField(target, false);
    return;
  }

  if (target.matches("[data-generation-key]")) {
    // 婵犵數濮烽弫鍛婃叏閹绢喗鏅濋柕澶嗘櫅閸ㄥ倿鏌涢…鎴濅簼闁告瑥绻橀弻宥夊传閸曨剙娅ｇ紓?闂?闂傚倸鍊峰ù鍥ь浖閵娾晜鍊块柨鏇楀亾妞ゎ厼鐏濋～婊堝焵椤掑嫬绠栧Δ锔筋儥濡茬厧鈹戦悙闈涘付缂佺粯锕㈤悰顔碱潨閳ь剙鐣峰鈧獮鎾诲箳閹惧湱鍙?闂傚倸鍊风粈渚€骞夐敓鐘冲殞濡わ絽鍟€氬銇勯幒鎴濐伌闁?
    const group = target.closest(".bme-range-group");
    if (group) {
      const key = target.dataset.generationKey;
      const sibling = group.querySelector(
        target.type === "range" ? `.bme-range-number` : `.bme-range-input`,
      );
      if (sibling) sibling.value = target.value;
      // 闂傚倸鍊风粈渚€骞栭鈷氭椽濡舵径瀣槐闂侀潧艌閺呮盯鎷?label 濠电姷鏁搁崑鐐哄垂閸洖绠伴柟闂寸劍閺呮繈鏌ㄩ弴妤€浜鹃梺宕囩帛閹瑰洭鐛€ｎ喗鏅濋柍褜鍓涙竟鏇°亹閹烘挾鍘遍棅顐㈡处閹告悂骞冮幋锔界厓缂備焦蓱閳锋帞绱掓潏銊ユ诞闁糕斁鍋?
      const row = target.closest(".bme-config-row");
      const badge = row?.querySelector(".bme-range-value");
      if (badge) badge.textContent = target.value || "濠电姵顔栭崰妤冩暜濡ゅ啰鐭欓柟鐑樸仜閳ь剨绠撳畷濂稿Ψ椤旇姤娅?;
    }
    _persistGenerationField(target, false);
    return;
  }

  if (target.matches("[data-input-key]")) {
    _persistTaskInputField(target, false);
    return;
  }

  if (
    target.matches("[data-regex-rule-field]") ||
    target.matches("[data-regex-rule-source]") ||
    target.matches("[data-regex-rule-destination]")
  ) {
    if (isGlobalRegexPanel) {
      _persistSelectedGlobalRegexRuleField(target, false);
    } else {
      _persistSelectedRegexRuleField(target, false);
    }
    return;
  }

  if (target.matches("[data-regex-rule-row-enabled]")) {
    const ruleId = String(target.dataset.ruleId || "").trim();
    if (!ruleId) return;
    _persistRegexRuleEnabledById(ruleId, Boolean(target.checked), isGlobalRegexPanel, false);
  }
}

function _handleTaskProfileWorkspaceChange(event) {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const isGlobalRegexPanel = _isGlobalRegexPanelTarget(target);

  if (target.id === "bme-task-profile-select") {
    const settings = _getSettings?.() || {};
    const nextTaskProfiles = setActiveTaskProfileId(
      settings.taskProfiles || {},
      currentTaskProfileTaskType,
      target.value,
    );
    currentTaskProfileBlockId = "";
    currentTaskProfileRuleId = "";
    _patchTaskProfiles(nextTaskProfiles);
    return;
  }

  if (target.matches("[data-block-field]")) {
    _persistSelectedBlockField(target, true);
    return;
  }

  if (target.matches("[data-generation-key]")) {
    _persistGenerationField(target, true);
    return;
  }

  if (target.matches("[data-input-key]")) {
    _persistTaskInputField(target, true);
    return;
  }

  if (target.matches("[data-regex-field]")) {
    if (isGlobalRegexPanel) {
      _persistGlobalRegexField(target, false);
    } else {
      _persistRegexConfigField(target, false);
    }
    return;
  }

  if (target.matches("[data-regex-source]")) {
    if (isGlobalRegexPanel) {
      _persistGlobalRegexSourceField(target, false);
    } else {
      _persistRegexSourceField(target, false);
    }
    return;
  }

  if (target.matches("[data-regex-stage]")) {
    if (isGlobalRegexPanel) {
      _persistGlobalRegexStageField(target, false);
    } else {
      _persistRegexStageField(target, false);
    }
    return;
  }

  if (
    target.matches("[data-regex-rule-field]") ||
    target.matches("[data-regex-rule-source]") ||
    target.matches("[data-regex-rule-destination]")
  ) {
    if (isGlobalRegexPanel) {
      _persistSelectedGlobalRegexRuleField(target, true);
    } else {
      _persistSelectedRegexRuleField(target, true);
    }
    return;
  }

  if (target.matches("[data-regex-rule-row-enabled]")) {
    const ruleId = String(target.dataset.ruleId || "").trim();
    if (!ruleId) return;
    _persistRegexRuleEnabledById(ruleId, Boolean(target.checked), isGlobalRegexPanel, true);
  }
}

function _getTaskProfileWorkspaceState(settings = _getSettings?.() || {}) {
  const taskProfiles = ensureTaskProfiles(settings);
  const globalTaskRegex = _normalizeGlobalRegexDraft(settings.globalTaskRegex || {});
  const globalRegexRules = Array.isArray(globalTaskRegex.localRules)
    ? globalTaskRegex.localRules
    : [];
  const taskTypeOptions = getTaskTypeOptions();
  const runtimeDebug = _getRuntimeDebugSnapshot?.() || {
    hostCapabilities: null,
    runtimeDebug: null,
  };

  if (!taskTypeOptions.some((item) => item.id === currentTaskProfileTaskType)) {
    currentTaskProfileTaskType = taskTypeOptions[0]?.id || "extract";
  }

  if (!TASK_PROFILE_TABS.some((item) => item.id === currentTaskProfileTabId)) {
    currentTaskProfileTabId = TASK_PROFILE_TABS[0]?.id || "generation";
  }

  const bucket = taskProfiles[currentTaskProfileTaskType] || {
    activeProfileId: "default",
    profiles: [],
  };
  const profile =
    bucket.profiles.find((item) => item.id === bucket.activeProfileId) ||
    bucket.profiles[0] ||
    null;
  const blocks = _sortTaskBlocks(profile?.blocks || []);
  const regexRules = Array.isArray(profile?.regex?.localRules)
    ? profile.regex.localRules
    : [];

  if (currentTaskProfileBlockId && !blocks.some((block) => block.id === currentTaskProfileBlockId)) {
    currentTaskProfileBlockId = blocks[0]?.id || "";
  }
  if (currentTaskProfileRuleId && !regexRules.some((rule) => rule.id === currentTaskProfileRuleId)) {
    currentTaskProfileRuleId = regexRules[0]?.id || "";
  }
  if (currentGlobalRegexRuleId && !globalRegexRules.some((rule) => rule.id === currentGlobalRegexRuleId)) {
    currentGlobalRegexRuleId = globalRegexRules[0]?.id || "";
  }

  return {
    settings,
    taskProfiles,
    globalTaskRegex,
    globalRegexRules,
    showGlobalRegex: showGlobalRegexPanel,
    taskTypeOptions,
    taskType: currentTaskProfileTaskType,
    taskTabId: currentTaskProfileTabId,
    bucket,
    profile,
    blocks,
    selectedBlock:
      blocks.find((block) => block.id === currentTaskProfileBlockId) || null,
    regexRules,
    selectedRule:
      regexRules.find((rule) => rule.id === currentTaskProfileRuleId) || null,
    selectedGlobalRegexRule:
      globalRegexRules.find((rule) => rule.id === currentGlobalRegexRuleId) || null,
    builtinBlockDefinitions: getBuiltinBlockDefinitions(),
    runtimeDebug,
  };
}

function _refreshTaskProfileWorkspace(settings = _getSettings?.() || {}) {
  const workspace = document.getElementById("bme-task-profile-workspace");
  if (!workspace) return;

  const state = _getTaskProfileWorkspaceState(settings);
  workspace.innerHTML = _renderTaskProfileWorkspace(state);
}

function _getMessageTraceWorkspaceState(settings = _getSettings?.() || {}) {
  const panelDebug = _getRuntimeDebugSnapshot?.() || {
    hostCapabilities: null,
    runtimeDebug: null,
  };
  const runtimeDebug = panelDebug.runtimeDebug || {};

  return {
    settings,
    panelDebug,
    runtimeDebug,
    recallInjection: runtimeDebug?.injections?.recall || null,
    messageTrace: runtimeDebug?.messageTrace || null,
    recallLlmRequest: runtimeDebug?.taskLlmRequests?.recall || null,
    recallPromptBuild: runtimeDebug?.taskPromptBuilds?.recall || null,
    extractLlmRequest: runtimeDebug?.taskLlmRequests?.extract || null,
    extractPromptBuild: runtimeDebug?.taskPromptBuilds?.extract || null,
    taskTimeline: Array.isArray(runtimeDebug?.taskTimeline)
      ? runtimeDebug.taskTimeline
      : [],
    graph: _getGraph?.() || null,
  };
}

function _refreshMessageTraceWorkspace(settings = _getSettings?.() || {}) {
  const workspace = document.getElementById("bme-message-trace-workspace");
  if (!workspace) return;

  const state = _getMessageTraceWorkspaceState(settings);
  workspace.innerHTML = _renderMessageTraceWorkspace(state);
}

function _renderMessageTraceWorkspace(state) {
  const updatedCandidates = [
    state.recallInjection?.updatedAt,
    state.recallLlmRequest?.updatedAt,
    state.extractLlmRequest?.updatedAt,
    state.extractPromptBuild?.updatedAt,
    ...(Array.isArray(state.taskTimeline)
      ? state.taskTimeline.map((entry) => entry?.updatedAt)
      : []),
  ]
    .map((value) => Date.parse(String(value || "")))
    .filter((value) => Number.isFinite(value));
  const updatedAt = updatedCandidates.length
    ? new Date(Math.max(...updatedCandidates)).toISOString()
    : "";

  return `
    <div class="bme-task-tab-body">
      <div class="bme-task-toolbar-row">
        <span class="bme-task-pill">${_escHtml(_formatTaskProfileTime(updatedAt))}</span>
      </div>

      <div class="bme-task-debug-grid">
        <div class="bme-config-card">
          ${_renderMessageTraceRecallCard(state)}
        </div>
        <div class="bme-config-card">
          ${_renderMessageTraceExtractCard(state)}
        </div>
        <div class="bme-config-card">
          ${_renderAiMonitorTraceCard(state)}
        </div>
        <div class="bme-config-card">
          ${_renderAiMonitorCognitionCard(state)}
        </div>
      </div>
    </div>
  `;
}

function _renderMessageTraceRecallCard(state) {
  const injectionSnapshot = state.recallInjection || null;
  const recentMessages = Array.isArray(injectionSnapshot?.recentMessages)
    ? injectionSnapshot.recentMessages.map((item) => String(item || ""))
    : [];
  const lastSentUserMessage = String(
    state.messageTrace?.lastSentUserMessage?.text || "",
  ).trim();
  const triggeredUserMessage =
    lastSentUserMessage ||
    _extractTriggeredUserMessageFromRecentMessages(recentMessages);
  const hostPayloadText = _buildMainAiTraceText(
    triggeredUserMessage,
    injectionSnapshot?.injectionText || "",
  );
  const missingUserMessageNotice =
    injectionSnapshot && !triggeredUserMessage
      ? `
        <div class="bme-config-help">
          闂傚倷绀侀幖顐λ囬锕€鐤炬繝濠傜墛閸嬶繝鏌ㄩ弴鐐蹭簽闁轰礁鍟撮弻锝夊箻瀹曞洤鍝洪梺鍝勭焿缁犳捇寮诲澶婄厸濞达絽鎲″▓鑼磽娴ｅ搫校閻㈩垽绻濆璇测槈濡攱鐎诲┑鈽嗗灥濞咃絾绂掔粙搴撴斀闁绘劗顣介幏锟犳煕閹捐泛鏋涢柣娑卞櫍楠炲鏁冮埀顒勫础閹惰姤鐓冮柕澶堝劤閿涘秵銇勯弬鎸庮棦婵﹥妞藉畷銊︾節閸屾稖鐧佹俊鐐€х紞鍥ㄤ繆閸ヮ剙鐒?AI 闂傚倸鍊搁崐椋庢閿熺姴鐭楅煫鍥ㄦ礈缁€濠囨煃瑜滈崜娑氭閹烘绫嶉柛灞剧閻忓牓姊虹拠鈥崇仩闁哥喐娼欓悾鐑芥偄绾拌鲸鏅ｉ梺缁樻煥閹诧繝顢樿ぐ鎺撯拻濞达絿鐡斿鎰版煙閸涘﹤鈻曠€殿喓鍔嶅蹇涘煛閸愵亞鍘犻梻浣虹帛閸ㄧ厧螞閸曨厾涓嶉柟鐑樻尪娴滄粓鏌″鍐ㄥ姎闁逞屽墯椤ㄥ牏鍒掗崼鐔风窞闁归偊鍘鹃崢閬嶆⒑闂堟冻绱￠柛鎰枦缁查箖濡甸崟顖氱闁规儳澧庨悾鍝勨攽閻愯泛顥嶆い鏇嗗洤鐓濋幖娣妼缁犲鏌ц箛锝呬航濞寸媴绠撳缁樻媴閸涘﹤鏆堥梺鑽ゅ櫏閸ㄨ京绮嬪鍜佺叆闁割偆鍠庨崜鐢告倵楠炲灝鍔氭繛灞傚姂閹矂宕卞☉娆戝弰闂婎偄娲﹂崙鐟邦焽閹扮増鐓曢柍杞扮閳ь剙娼￠獮鍐ㄎ旈崨顓熷祶濡炪倖鎸鹃崑姗€宕Δ鈧—鍐Χ閸℃鍙嗗┑鐐寸ゴ閺呯姵淇婇悽绋跨疀闁哄鐏濆畵鍡涙⒑缂佹ê濮岄悘蹇旂懇瀹曘垽骞掑Δ浣叉嫼濠殿喚鎳撳ú銈嗕繆婵傚憡鍊垫慨妯煎帶閻忥附銇勯姀锛勬噰鐎规洖鐖奸、鏃堝幢濞嗘劖绶梻鍌欒兌绾爼宕滃┑濠冩噷闂備礁鎼Λ妤呮偋閹捐钃熸繛鎴炵矌閻も偓闁诲函缍嗘禍婊勬叏閺囥垺鈷戦柛婵嗗閸庡繘鏌涢悢鍛婄稇妞ゆ洩缍侀幃浠嬪礈閸欏娅屽┑鐘垫暩婵鈧凹鍣ｈ棟妞ゆ梻鏅粻楣冩煙鐎电浠﹂悘蹇ｅ幘缁辨帗寰勭€ｎ偄鍞夐悗瑙勬处閸ㄥ爼宕洪埀顒併亜閹烘垵顏柣?recall 婵犵數濮烽。钘壩ｉ崨鏉戝瀭妞ゅ繐鐗嗛悞鍨亜閹哄棗浜剧紒鍓ц檸閸欏啴宕洪埀顒併亜閹烘垵顏存俊顐ｅ灴閺岀喐顦版惔鈾€鏋呴梺鍝勮閸斿酣鍩€椤掑﹦绉甸柛鎾村哺瀹曠喐銈ｉ崘鈹炬嫼闂佸憡绋戦…顒勬倿閻愵兙浜滈柡鍥ф閸犳岸宕甸弴鐏诲綊鎮╁顔煎壈缂備胶濮惧▍鏇㈠Φ閸曨垼鏁囬柣鏃堫棑椤戝倻绱撴担鎻掍壕婵犮垼鍩栭崝鏍煕閹寸偑浜滈柟鍝勬娴滈箖姊虹拠鑼缂佽鐗嗛悾鐑藉閵堝憘褔鏌涢妷锝呭闁绘繃婢橀—鍐Χ閸℃瑥顫ч梺鍛婂灥缂嶅﹤鐣烽悽绋课у璺侯儑閸樼敻姊虹紒妯虹仸闁挎氨绱掑Δ浣稿摵闁哄矉缍侀獮娆撳礋椤撶姷妲囧┑?
        </div>
      `
      : "";

  if (!injectionSnapshot) {
    return `
      <div class="bme-config-card-title">闂傚倸鍊风粈渚€骞栭锔藉亱闁告劦鍠栫壕濠氭煙閸撗呭笡闁绘挻娲橀幈銊ヮ潨閸℃顫╁銈嗗竾閸ㄤ粙寮婚埄鍐╁闁告繂瀚Σ鎰版倵鐟欏嫭绀冩い銊ワ攻娣囧﹪鎮块锝喰梻浣稿悑閻℃洖鈻斿☉銏犵叀?AI 闂傚倸鍊烽悞锕傛儑瑜版帒绀夌€光偓閳ь剟鍩€椤掍礁鍤柛鎾跺枎閻ｇ兘顢楅崒妤€浜鹃柣銏㈡暩閵嗗﹪鏌?/div>
      <div class="bme-config-help">
        闂傚倷绀侀幖顐λ囬锕€鐤炬繝濠傛閹冲矂姊绘担鍦菇闁稿酣浜堕獮濠偽熸笟顖氭闂佸壊鐓堥崑鍕閻愭祴鏀介柣妯诲絻閳ь兛绮欓、娆愬緞閹邦厸鎷哄┑鐐跺皺缁垱绻涢崶顒佺厱闁哄倸娼￠妤呮煃缂佹ɑ宕屾鐐差儔閺佸啴鍩€椤掑嫭鍎楁俊銈勯檷娴滄粓鏌熼崫鍕棞濞存粍鍎抽埞鎴︽倷閹绘帞楠囬梺缁橆殕濞茬喖宕洪姀銈呯睄闁割偅鎯婇埡鍛厪濠㈣泛鐗嗛崝姘叏鐟欏嫮鍙€婵☆偄鎳橀、鏇㈠閿涘嫨鍋愰梻浣侯焾椤戝懎螞濠靛棛鏆﹂柨婵嗘閸庣喖鏌曟繛鍨壔闁靛鏅滈悡鏇㈡倶閻愭潙绀冨瑙勶耿閹粙顢涘Ο鍝勫闂侀€涚┒閸斿矂鍩為幋锕€绠婚悹鍝勬惈閻撳倿姊绘担铏瑰笡闁绘娲熼幃銉╂偂鎼达絾娈鹃梺鎸庣箓椤︻垳绮婚敐鍡欑瘈濠电姴鍊规刊鐓幟归悡搴㈠枠婵﹥妞藉畷顐﹀礋閸倣銏ゆ⒑閸涘﹥灏扮紒璇插閸掓帡寮崼鐔封偓濠氭煢濡警妲洪柣锝呭暱椤啴濡堕崱娆忊叺闂佺锕ラ〃鍫㈠垝閸喎绶為柟閭﹀幖娴狀垱绻涙潏鍓у埌鐎殿喛娉涢埢宥夊幢濞嗘劕鏋戦梺鍝勵槸閻忔繈寮抽悙鐢电＜闁稿本绋戝ù顔筋殽閻愬弶顥㈡鐐茬Ч椤㈡瑩骞嗚椤︻參姊绘担绛嬪殭婵炲鍏橀獮濠囧箻鐎垫悂妾梺鍝勫暙閸婂宕″鑸靛€垫繛鎴烆伆閹寸偞鍙忔繝濠傚娴滄粓鏌￠崘銊モ偓鍝ユ暜閸洘鍊堕煫鍥ㄦ尰椤ャ垽鏌＄仦鍓ф创濠碉紕鏌夐ˇ鎻捗归悩宕囩煂闁逞屽墲椤骞愮粙璇炬稑鈹戦崱娆愭闂佹寧绻傞ˇ浠嬪极瀹ュ棔绻嗘い鏍ㄨ壘濡茶霉?
      </div>
    `;
  }

  return `
    <div class="bme-config-card-head">
      <div>
        <div class="bme-config-card-title">闂傚倸鍊风粈渚€骞栭锔藉亱闁告劦鍠栫壕濠氭煙閸撗呭笡闁绘挻娲橀幈銊ヮ潨閸℃顫╁銈嗗竾閸ㄤ粙寮婚埄鍐╁闁告繂瀚Σ鎰版倵鐟欏嫭绀冩い銊ワ攻娣囧﹪鎮块锝喰梻浣稿悑閻℃洖鈻斿☉銏犵叀?AI 闂傚倸鍊烽悞锕傛儑瑜版帒绀夌€光偓閳ь剟鍩€椤掍礁鍤柛鎾跺枎閻ｇ兘顢楅崒妤€浜鹃柣銏㈡暩閵嗗﹪鏌?/div>
      </div>
      <span class="bme-task-pill">${_escHtml(_formatTaskProfileTime(injectionSnapshot.updatedAt))}</span>
    </div>
    ${missingUserMessageNotice}
    ${_renderMessageTraceTextBlock(
      "闂傚倸鍊风粈渚€骞夐敓鐘冲仭闁挎洖鍊搁崹鍌炴煕瑜庨〃鍛存倿閸偁浜滈柟杈剧到閸旂敻鏌涜箛鎾剁伇缂佽鲸甯￠、娆撳箚瑜滈弳顓犵磽?AI 闂傚倸鍊烽悞锕傛儑瑜版帒绀夌€光偓閳ь剟鍩€椤掍礁鍤柛鎾跺枎閻ｇ兘顢楅崒妤€浜鹃柣銏㈡暩閵嗗﹪鏌?,
      hostPayloadText,
      "闂傚倷绀侀幖顐λ囬锕€鐤炬繝濠傜墛閸嬶繝鏌ㄩ弴鐐蹭簽闁轰礁鍟撮弻锝夊箻瀹曞洤鍝洪梺鍝勭焿缁犳捇寮诲澶婄厸濞达絽鎲″▓鑼磽娴ｅ搫校閻㈩垽绻濆濠氭偄閻戞ê鏋傞梺鍛婃处閸撴盯藝椤斿槈鏃堟偐闂堟稐绮剁紓浣虹帛閿氶柣锝呭槻椤繈顢橀妸褏鐓戝┑鐐舵彧缁蹭粙骞楀鍏?AI 濠电姷鏁搁崑鐐哄箰婵犳碍鍎嶆繝濠傜墕瀹告繃銇勯弮鍌氫壕婵炲牆鎲＄换婵嬫偨闂堟稐绮跺銈忓瘜閸欏啫鐣峰┑鍡欐殕闁告洦鍋嗛悡鎴︽⒑缁洖澧茬紒瀣灩缁牓宕橀鐣屽幈濠电偞鍨靛畷顒€顕ｆィ鍐╃厱闁绘棃鏀遍崰姗€鏌?,
    )}
  `;
}

function _renderMessageTraceExtractCard(state) {
  const extractLlmRequest = state.extractLlmRequest || null;
  const extractPromptBuild = state.extractPromptBuild || null;
  const extractPayloadText = _buildTraceMessagePayloadText(
    extractLlmRequest?.messages,
    extractPromptBuild,
  );

  if (!extractLlmRequest && !extractPromptBuild) {
    return `
      <div class="bme-config-card-title">闂傚倸鍊风粈渚€骞栭锔藉亱闁告劦鍠栫壕濠氭煙閸撗呭笡闁绘挻娲橀幈銊ヮ潨閸℃鈷嬮梺鍛婄懃鐎氫即寮诲鍫闂佺绻戠粙鎾跺垝閸喓鐟归柍褜鍓熼幃浼搭敋閳ь剟鐛Ο鍏煎珰闁肩⒈鍓﹂崬浠嬫⒒娴ｅ摜绉洪柛瀣躬瀹曟粌鈻庨幋婵堢瓘闂佸湱顭堢花鑲╂崲閸℃ǜ浜滈柡宥冨妸娴犳粓鏌涚€ｎ偅灏柣锝囧厴瀹曞爼鏁愰崨顒€顥氶梻浣虹帛閸ㄥ吋鎱ㄩ妶澶婄？鐎广儱顦伴悡鏇㈡煛閸ャ儱濡煎ù婊勭矒閺屸剝鎷呴崫銉ョ厽闂?/div>
      <div class="bme-config-help">
        闂傚倷绀侀幖顐λ囬锕€鐤炬繝濠傛閹冲矂姊绘担鍦菇闁稿酣浜堕獮濠偽熸笟顖氭闂佸壊鐓堥崑鍕閻愭祴鏀介柣妯诲絻閳ь兛绮欓、娆愬緞閹邦厸鎷哄┑鐐跺皺缁垱绻涢崶顒佺厱闁哄倸娼￠妤呮煃缂佹ɑ宕屾鐐差儔閺佸啴鍩€椤掑倻涓嶉柣銏犳啞閻撴瑩姊洪銊х暠濠⒀屽枤缁辨帡骞撻幒鎾充淮闂佽鍠栫紞濠傜暦閸洦鏁嗗ù锝堫潐濞堟悂姊绘担瑙勩仧濞存粍绻冮崚濠囨偩瀹€鈧稉宥嗙箾閹存瑥鐒洪柡浣稿暣閺屾洟宕煎┑鍥ф闁诲孩鍐荤紞浣割潖濞差亝顥堟繛鎴炵懐濡偤姊虹粙鍖″伐妞ゎ厾鍏橀獮?assistant 婵犵數濮甸鏍窗濡ゅ啯宕查柟閭﹀枛缁躲倕霉閻樺樊鍎愰柛瀣樀閺屾盯顢曢敐鍡欘槬闂佺粯鍔曢敃顏堝蓟閿濆绠涙い鏍ㄦ皑濮ｃ垽姊洪崫鍕棡闁煎綊绠栭崺銉﹀緞閹邦剛顔掑銈嗙墬閻喗绔熼弴銏♀拺闁告繂瀚峰Σ娲煕鎼淬垹濮嶇€规洘濞婇、娑橆煥閸曞灚缍楁繝鐢靛█濞佳囶敄閸℃稑鍚瑰┑鐘插暔娴滄粓鐓崶銊﹀碍妞ゅ繆鏅濋幃顕€鎮㈤崗灏栨嫼闂侀潻瀵岄崢鍓ф暜濞戙垺鐓曢柡鍐ｅ亾婵炲弶绻堟俊鐢稿箛閺夎法鍊為梺鍐叉惈閸婂摜澹曢鐐粹拺缁绢厼鎳忚ぐ褏绱掗懠鑸电《缂侇喖顭峰浠嬵敇閻斿搫骞堟繝娈垮枟閿曗晠宕滃璺鸿埞濠㈣泛鐬肩壕鑲╃磽娴ｈ鐒藉褏鏁婚弻锛勪沪閻ｅ瞼浼囨繛瀵稿缁犳捇骞婇悙鍝勎ㄧ憸搴敇鐠囨祴鏀介柣鎰摠缂嶆垿鏌涘顒夊剶闁硅櫕绻冮妶锝夊礃閵娿儲鍎俊鐐€栭幐鍫曞垂濞差亜纾绘繝闈涱儐閻撶娀鏌涢幘鏉戠祷闁告ɑ鎸抽弻?
      </div>
    `;
  }

  return `
    <div class="bme-config-card-head">
      <div>
        <div class="bme-config-card-title">闂傚倸鍊风粈渚€骞栭锔藉亱闁告劦鍠栫壕濠氭煙閸撗呭笡闁绘挻娲橀幈銊ヮ潨閸℃鈷嬮梺鍛婄懃鐎氫即寮诲鍫闂佺绻戠粙鎾跺垝閸喓鐟归柍褜鍓熼幃浼搭敋閳ь剟鐛Ο鍏煎珰闁肩⒈鍓﹂崬浠嬫⒒娴ｅ摜绉洪柛瀣躬瀹曟粌鈻庨幋婵堢瓘闂佸湱顭堢花鑲╂崲閸℃ǜ浜滈柡宥冨妸娴犳粓鏌涚€ｎ偅灏柣锝囧厴瀹曞爼鏁愰崨顒€顥氶梻浣虹帛閸ㄥ吋鎱ㄩ妶澶婄？鐎广儱顦伴悡鏇㈡煛閸ャ儱濡煎ù婊勭矒閺屸剝鎷呴崫銉ョ厽闂?/div>
      </div>
      <span class="bme-task-pill">${_escHtml(
        _formatTaskProfileTime(extractLlmRequest?.updatedAt || extractPromptBuild?.updatedAt),
      )}</span>
    </div>
    ${_renderMessageTraceTextBlock(
      "闂傚倸鍊风粈渚€骞夐敓鐘冲仭闁挎洖鍊搁崹鍌炴煕瑜庨〃鍛存倿閸偁浜滈柟杈剧稻绾埖銇勯敂濂告妞ゃ劊鍎甸幃娆戔偓娑櫭壕鍐参旈悩闈涗沪闁圭懓娲悰顕€宕堕澶嬫櫌闂侀€炲苯澧扮€垫澘锕獮鎰償濠靛牏鐣炬俊鐐€栭悧妤呭Φ濞戙垹纾婚柟鎯х－閺嗭箓鏌涢妷顖滃埌濞存粓绠栭弻锝夊箣閿濆憛鎾绘煕鎼达紕效闁哄本鐩鎾Ω閵夈倗鐩庨梻浣芥〃缁€渚€鎮ユ總绋跨畺?,
      extractPayloadText,
      "闂傚倷绀侀幖顐λ囬锕€鐤炬繝濠傜墛閸嬶繝鏌ㄩ弴鐐蹭簽闁轰礁鍟撮弻锝夊箻瀹曞洤鍝洪梺鍝勭焿缁犳捇寮诲澶婄厸濞达絽鎲″▓鑼磽娴ｅ搫校閻㈩垽绻濆濠氭偄閻戞ê鏋傞梺鍛婃处閸撴盯藝椤斿槈鏃堟偐闂堟稐绮剁紓浣虹帛閿氶柣锝呭槻椤繈鎳滈棃娑楃綍闂備礁澹婇崑鍛崲閸曨垰纾归柟鐑橆殕閳锋垿鏌涘☉姗堝姛闁瑰啿瀚伴弻锝呂旈崘銊ゆ濡炪們鍨哄畝鎼併€佸Δ鍛劦妞ゆ帊鐒﹀▍蹇涙⒒娴ｄ警鐒鹃柡鍫墴閹虫繃銈ｉ崘銊︾€梺鍓插亝濞叉﹢宕愰悽鍛婄厽闁绘梻顭堥ˉ瀣煟閿濆骸寮柡?,
    )}
  `;
}

function _formatDurationMs(durationMs) {
  const normalized = Number(durationMs);
  if (!Number.isFinite(normalized) || normalized <= 0) return "闂?;
  if (normalized < 1000) return `${Math.round(normalized)}ms`;
  return `${(normalized / 1000).toFixed(normalized >= 10000 ? 0 : 1)}s`;
}

function _getMonitorTaskTypeLabel(taskType = "") {
  const normalized = String(taskType || "").trim().toLowerCase();
  const labels = {
    extract: "闂傚倸鍊风粈浣革耿鏉堚晛鍨濇い鏍仜缁€澶愭煛閸ゅ爼顣﹀Ч?,
    recall: "闂傚倸鍊风粈渚€骞夐敓鐘冲仭妞ゆ牜鍋涚粈鍫熺箾閸℃璐?,
    consolidation: "闂傚倸鍊峰ù鍥ь浖閵娾晜鍊块柨鏇楀亾妞ゎ厼娲ら埢搴ㄥ箻瀹曞洨鏆?,
    compress: "闂傚倸鍊风粈渚€骞夐敓鐘虫櫔婵＄偑鍊栭崹闈浢洪妸褎顫?,
    synopsis: "闂傚倷娴囬褏鎹㈤幇顔藉床闁归偊鍠楀畷鏌ユ煙鏉堝墽鐣遍柣鎺戠仛閵囧嫰骞掗幋婵囨闂佸憡鑹惧﹢杈╂?,
    summary_rollup: "闂傚倸鍊峰ù鍥敋閺嶎厼绀堟繝闈涙閺嗭箓鏌ｉ姀銈嗘锭闁搞劍绻堥弻鏇熺箾閻愵剚鐝旂紓浣哄閸犳绌辨繝鍥舵晬婵﹩鍘介崕鎾剁磽?,
    reflection: "闂傚倸鍊风粈渚€骞夐敓鐘冲仭闁靛／鍛厠闂佹眹鍨婚…鍫ユ倿?,
    sleep: "闂傚倸鍊搁崐椋庢閿熺姴绀堟慨妯跨堪閳ь剙鍟村畷銊╊敍濞戞ê绨?,
    evolve: "闂傚倷绀侀幖顐λ囬锕€鐤炬繝濠傛噽閻瑩鏌熺€电袥闁?,
    embed: "闂傚倸鍊风粈渚€骞夐敍鍕瀳鐎广儱顦崹鍌炴煕瑜庨〃鍛存⒒?,
    rebuild: "闂傚倸鍊搁崐鐑芥倿閿曚降浜归柛鎰典簽閻捇鎮楅棃娑欐喐缁?,
  };
  return labels[normalized] || String(taskType || "闂傚倸鍊风粈渚€骞栭锔藉亱婵犲﹤瀚々鏌ユ煟閹邦喖鍔嬮柛瀣€块弻宥夊煛娴ｅ憡娈跺銈傛櫇閸忔﹢骞冭ぐ鎺戠倞闁靛鍎崇粊宄邦渻?);
}

function _getMonitorStatusLabel(status = "") {
  const normalized = String(status || "").trim().toLowerCase();
  if (!normalized) return "闂傚倸鍊风粈渚€骞栭锔藉亱婵犲﹤瀚々鏌ユ煟閹邦喖鍔嬮柛瀣€块弻銊╂偄閸濆嫅锝夋煕鐎ｎ偄濮嶉柡灞诲€濆畷顐﹀Ψ椤旇姤鐦滈梻?;
  if (normalized.includes("error") || normalized.includes("fail")) return "濠电姷鏁告慨浼村垂濞差亜纾块柤娴嬫櫅閸ㄦ繈鏌涢幘妤€瀚弸?;
  if (normalized.includes("run")) return "闂傚倷绀侀幖顐λ囬锕€鐤炬繝濠傜墕缁€澶嬫叏濡炶浜鹃梺闈涙缁舵岸鐛€ｎ喗鍊风痪鐗埳戦悘?;
  if (normalized.includes("queue")) return "闂傚倸鍊风粈浣革耿闁秴纾块柕鍫濇处閺嗘粓鏌嶉妷锔剧獮闁挎繂顦伴弲婊堟煟閿濆懎顦柡?;
  if (normalized.includes("pending")) return "缂傚倸鍊搁崐鐑芥倿閿斿墽鐭欓柟娆¤娲、娑橆煥閸曢潧浠洪梻浣虹帛閺屻劑骞楀鍫濈厺?;
  if (normalized.includes("skip")) return "闂備浇顕у锕傦綖婢舵劖鍋ら柡鍥╁С閻掑﹥銇勮箛鎾跺闁稿﹤顭烽弻銊╁籍閸ヮ灝鎾趁?;
  if (normalized.includes("fallback")) return "闂備浇顕уù鐑藉箠閹捐绠熼梽鍥Φ閹版澘绀冩い顓烆儐濡炶棄顕ｆ禒瀣垫晣闁绘柨鎼慨鐑芥⒒?;
  if (normalized.includes("disable")) return "闂備浇顕уù鐑藉箠閹捐绠熼梽鍥Φ閹版澘绀冩い鏃囧亹閻撴垿鎮峰鍕叆妞?;
  if (
    normalized.includes("success") ||
    normalized.includes("complete") ||
    normalized.includes("done") ||
    normalized === "ok"
  ) {
    return "闂傚倸鍊烽懗鍫曞箠閹剧粯鍋ら柕濞炬櫅缁€澶愭煛閸モ晛鏋戦柛?;
  }
  return String(status || "闂傚倸鍊风粈渚€骞栭锔藉亱婵犲﹤瀚々鏌ユ煟閹邦喖鍔嬮柛瀣€块弻銊╂偄閸濆嫅锝夋煕鐎ｎ偄濮嶉柡灞诲€濆畷顐﹀Ψ椤旇姤鐦滈梻?);
}

function _getMonitorRoleLabel(role = "") {
  const normalized = String(role || "").trim().toLowerCase();
  const labels = {
    system: "缂傚倸鍊搁崐椋庢閿熺姴鍨傞梻鍫熺〒閺嗭箓鏌ｉ姀銈嗘锭闁?,
    user: "闂傚倸鍊烽悞锕€顪冮崹顕呯劷闁秆勵殔缁€澶屸偓骞垮劚椤︻垶寮?,
    assistant: "闂傚倸鍊风粈渚€骞夐敓鐘茶摕闁跨喓濮撮悿鐐節婵犲倸顏繛?,
    tool: "闂備浇顕у锕傦綖婢舵劕绠栭柛顐ｆ礀绾惧潡姊洪鈧粔鎾儗?,
  };
  return labels[normalized] || String(role || "闂傚倸鍊风粈渚€骞栭锔藉亱婵犲﹤瀚々鏌ユ煟閹邦喖鍔嬮柛?);
}

function _getMonitorRouteLabel(value = "") {
  const normalized = String(value || "").trim();
  if (!normalized) return "";
  const labels = {
    "dedicated-openai-compatible": "濠电姷鏁搁崑鐐哄垂閸洖绠板┑鐘宠壘缁犳澘螖閿濆懎鏆欓柡?OpenAI 闂傚倸鍊烽懗鍫曗€﹂崼銏″床闁圭儤顨呴崒銊ф喐閺冨牄鈧礁鈻庨幘宕囩杸闂佸搫顦冲▔鏇㈩敊婵犲洦鈷戦梻鍫熶緱濡插爼鏌涙惔銈勫惈缂?,
    "sillytavern-current-model": "闂傚倸鍊搁崐鐑芥嚄閼稿灚娅犳俊銈呭暞閺嗘粓鏌ㄩ悢鍝勑為柍褜鍓欓幊姗€銆侀弴銏犖ㄩ柨婵嗗閻繘姊绘担绛嬫綈闁稿孩濞婂畷顖炲锤濡炴梻鍏樺畷銊╊敊閼姐倗鐣炬俊鐐€栭悧妤呭Φ濞戙垹纾婚柟鎯х－閺嗭箓鏌涢妷顖滃埌濞?,
    "dedicated-memory-llm": "濠电姷鏁搁崑鐐哄垂閸洖绠板┑鐘宠壘缁犳澘螖閿濆懎鏆欓柡瀣╃窔閺屾洟宕煎┑鍥ь槱婵犳鍨伴妶鎼佸蓟閳╁啫绶為幖娣灮閵嗗﹦绱撴担鍝勑ｉ柟鍝ョ帛缁岃鲸绻濋崶鑸垫櫖濠碉紕鍋犻褎绂嶉崜褉鍋撶憴鍕婵炶尙濞€瀹?,
    global: "闂傚倷娴囧畷鍨叏閹€鏋嶉柨婵嗩槸缁愭鏌″畵顔瑰亾闁哄妫冮弻鏇＄疀閵壯呫偡婵炲瓨绮岀紞濠囧蓟閻旂厧绠氱憸宥夊汲鏉堛劊浜?API",
    "task-preset": "濠电姷鏁搁崑娑㈩敋椤撶喐鍙忓Δ锝呭枤閺佸鎲告惔銊ョ疄闁靛ň鏅滈崑鍕煕濠靛嫬鍔楅柡瀣墵濮婅櫣鎲撮崟顐ゎ槰闂佺硶鏅滈悧鐘差嚕鐎圭姷鐤€闁哄倸澧界粻姘渻閵堝棛澧い銊ユ噺閺呭爼宕ｆ径宀€鐦?,
    "global-fallback-missing-task-preset": "濠电姷鏁搁崑娑㈩敋椤撶喐鍙忓Δ锝呭枤閺佸鎲告惔銊ョ疄闁靛ň鏅滈崑鍕煠閼艰埖顏犻柛鐘崇墵瀹曟椽宕熼姘鳖槰闂佸啿鎼崯顐﹀吹閹烘梻纾介柛灞捐壘閳ь剚鎮傚畷鎰板箹娴ｅ摜顔愬銈嗗姧缁犳垶顢婇梻浣侯攰閹活亪姊介崟顖氱柧妞ゆ帒瀚崐鍫曟煟閹邦垰鐓愭い銉ヮ樀閺屾盯濡堕崱妤佽癁闂佸搫鏈惄顖涗繆閻ゎ垼妲绘繛瀵稿█娴滃爼寮诲鍫闂佺绻戦敃銏犵暦閹达箑绠婚柤鎼佹涧閺嬫垿姊虹紒姗嗘當闁绘锕︽禍鎼侇敇閻戝棛鍞?API",
    "global-fallback-invalid-task-preset": "濠电姷鏁搁崑娑㈩敋椤撶喐鍙忓Δ锝呭枤閺佸鎲告惔銊ョ疄闁靛ň鏅滈崑鍕煠閼艰埖顏犻柛鐘崇墵瀹曟椽宕熼姘鳖槰闂佸啿鎼崯顐﹀吹閹烘垟鏀介柣鎰綑閻忥箓鏌熺粙鎸庢喐缂侇喗妫冮獮姗€顢欓挊澶夋偅婵＄偑鍊栫敮鎺斺偓姘煎墴瀵憡绗熼埀顒€顕ｉ崼鏇為唶婵犻潧妫岄幐鍐磽娴ｆ彃浜炬繝銏ｆ硾婢跺洭宕戦幘缁樺仭闁绘鐗嗛弳鍫ユ偡濠婂嫭绶查柛鐕佸亞閸欏懘姊洪崫鍕枆闁告ü绮欓幃鐐寸節濮橆厾鍘撻悷婊勭矒瀹曟粌鈹戠€ｎ€箓鏌熼悧鍫熺凡缂佺姴顭烽弻娑㈠箛椤掍讲鏋欓梺鍝勵儌閸?API",
  };
  return labels[normalized] || normalized;
}

function _getMonitorStageLabel(stage = "") {
  const normalized = String(stage || "").trim();
  if (!normalized) return "闂?;
  const labels = {
    "input.userMessage": "闂傚倷绀侀幖顐λ囬鐐村亱濠电姴娲ょ粻浼存煙闂傚顦﹂柣顓燁殜閺屾盯鍩勯崘顏佸闂佹娊鏀遍幑鍥蓟閵堝宸濆┑鐘查閺呴亶姊? 闂備浇宕甸崰鎰垝鎼淬垺娅犳俊銈呮噹缁犱即鏌涘☉姗堟敾婵炲懐濞€閺岋絽螣閼测晛绗￠梺绋款儍閸旀垿寮婚弴鐔虹瘈闊洦娲滈弳鐘绘⒑缂佹ɑ灏版繛鍙夘焽閹广垹鈽夐姀鐘殿吅濠电娀娼ч悧鍡浡烽埀顒€鈹?,
    "input.recentMessages": "闂傚倷绀侀幖顐λ囬鐐村亱濠电姴娲ょ粻浼存煙闂傚顦﹂柣顓燁殜閺屾盯鍩勯崘顏佸闂佹娊鏀遍幑鍥蓟閵堝宸濆┑鐘查閺呴亶姊? 闂傚倸鍊风粈渚€骞栭锔藉亱闁告劦鍠栫壕濠氭煙閹规劦鍤欑紒鐙欏洦鐓冮柛婵嗗閳ь剚鎮傞幃姗€鏁傞崜褏锛滄繝銏ｆ硾閼活垶宕㈢€涙﹩娈?,
    "input.candidateText": "闂傚倷绀侀幖顐λ囬鐐村亱濠电姴娲ょ粻浼存煙闂傚顦﹂柣顓燁殜閺屾盯鍩勯崘顏佸闂佹娊鏀遍幑鍥蓟閵堝宸濆┑鐘查閺呴亶姊? 闂傚倸鍊烽懗鍫曗€﹂崼銉︽櫇闁靛鏅滈崑锟犳煃閸濆嫭鍣归柣鎺戠仛閵囧嫰骞掗崱妞惧婵＄偑鍊х紓姘跺础閸愬樊鍤曢柟闂寸缁€鍐┿亜閺冨倸甯堕柣?,
    "input.finalPrompt": "闂傚倷绀侀幖顐λ囬鐐村亱濠电姴娲ょ粻浼存煙闂傚顦﹂柣顓燁殜閺屾盯鍩勯崘顏佸闂佹娊鏀遍幑鍥蓟閵堝宸濆┑鐘查閺呴亶姊? 闂傚倸鍊风粈渚€骞栭锔藉亱闁告劦鍠栫壕濠氭煙閹冾暢缁炬崘妫勯湁闁挎繂鎳忛幉绋款熆瑜庣粙鎾诲箟閸涘绱ｅù锝堟閸橈紕绱撴笟鍥ф灈闁绘锕俊鍫曟晜閻愵剙纾梺闈浢犻埀?,
    "output.rawResponse": "闂傚倷绀侀幖顐λ囬鐐村亱濠电姴娲ょ粻浼存煙闂傚顦﹂柛姘愁潐閵囧嫰骞橀崡鐐典痪闂佹娊鏀遍幑鍥蓟閵堝宸濆┑鐘查閺呴亶姊? 闂傚倸鍊风粈渚€骞夐敓鐘偓锕傚炊椤掆偓缁愭骞栭幖顓犲帨缂傚秵鐗犻弻鐔兼偋閸喓鍑℃繛纾嬪亹婵兘鍩€椤掆偓缁犲秹宕曢柆宥呯疇闁归偊鍠掗崑?,
    "output.beforeParse": "闂傚倷绀侀幖顐λ囬鐐村亱濠电姴娲ょ粻浼存煙闂傚顦﹂柛姘愁潐閵囧嫰骞橀崡鐐典痪闂佹娊鏀遍幑鍥蓟閵堝宸濆┑鐘查閺呴亶姊? 闂傚倷娴囧畷鐢稿窗閹扮増鍋￠弶鍫氭櫅缁躲倕螖閿濆懎鏆為柛濠囨涧闇夐柣妯烘▕閸庡繒绱掗埀?,
    "world-info-rendered": "濠电姷鏁搁崑鐐哄垂閸洖绠板┑鐘崇閸嬪绻濇繝鍌滃闁汇倗鍋撻妵鍕箛閸撲焦鍋ч梺宕囩帛濞茬喖寮婚妸鈺佹閹煎瓨鎸告禍楣冩煟閺囨氨鍔嶉柤绋跨秺濮婄粯鎷呴崨濠冨創闂佸搫鐗滈崜鐔肩嵁閹版澘绠瑰ù锝呮憸閻?,
    "final-injection-safe": "婵犵數濮烽弫鎼佸磻濞戔懞鍥敇閵忕姷顦悗鍏夊亾闁告洦鍋嗛悡鎴︽⒑缁洖澧茬紒瀣灩缁牓宕橀鐣屽幈濠电偞鍨靛畷顒€顕ｆィ鍐╃厱闁绘棃鏀遍崰姗€鏌″畝瀣瘈鐎规洜鍘ч～婵嬵敄閸噮妫滅紓鍌氬€搁崐鎼佸磹妞嬪海鐭嗗〒姘ｅ亾闁诡啫鍕瘈闁告洦鍘煎畷銉╂煟閻樺弶绌挎い?,
    "host:user_input": "闂傚倷娴囬褍霉閻戣棄绠犻柟鎹愵嚙妗呭┑鈽嗗灠閻ㄧ兘宕戦幘缁橆棃婵炴垶绮岄顓㈡⒑瀹曞洨甯涙俊顐㈠暞娣囧﹪骞栨担鑲濄劑鏌曟径鍫濆姕閺? 闂傚倸鍊烽悞锕€顪冮崹顕呯劷闁秆勵殔缁€澶屸偓骞垮劚椤︻垶寮伴妷锔剧闁瑰鍋熼幊鍕磽瀹ュ懏鍠橀柡宀€鍠栭獮鍡氼槻闁哄棜浜埀?,
    "host:ai_output": "闂傚倷娴囬褍霉閻戣棄绠犻柟鎹愵嚙妗呭┑鈽嗗灠閻ㄧ兘宕戦幘缁橆棃婵炴垶绮岄顓㈡⒑瀹曞洨甯涙俊顐㈠暞娣囧﹪骞栨担鑲濄劑鏌曟径鍫濆姕閺? AI 闂傚倷绀侀幖顐λ囬鐐村亱濠电姴娲ょ粻浼存煙闂傚顦﹂柛?,
    "host:world_info": "闂傚倷娴囬褍霉閻戣棄绠犻柟鎹愵嚙妗呭┑鈽嗗灠閻ㄧ兘宕戦幘缁橆棃婵炴垶绮岄顓㈡⒑瀹曞洨甯涙俊顐㈠暞娣囧﹪骞栨担鑲濄劑鏌曟径鍫濆姕閺? 濠电姷鏁搁崑鐐哄垂閸洖绠板┑鐘崇閸嬪绻濇繝鍌滃闁汇倗鍋撻妵鍕箛閸撲焦鍋ч梺?,
    "host:reasoning": "闂傚倷娴囬褍霉閻戣棄绠犻柟鎹愵嚙妗呭┑鈽嗗灠閻ㄧ兘宕戦幘缁橆棃婵炴垶绮岄顓㈡⒑瀹曞洨甯涙俊顐㈠暞娣囧﹪骞栨担鑲濄劑鏌曟径鍫濆姕閺? 闂傚倸鍊峰ù鍥敋閺嶎厼绀堟慨妯块哺瀹曟煡鏌涢弴銊モ偓鎾存償椤垶鏅梺閫炲苯澧寸€?闂傚倸鍊峰ù鍥綖婢跺顩插ù鐘差儏缁€澶愬箹濞ｎ剙濡肩紒?,
  };
  return labels[normalized] || normalized;
}

function _formatMonitorStageList(stages = []) {
  if (!Array.isArray(stages) || !stages.length) return "闂?;
  return stages
    .map((entry) => _getMonitorStageLabel(entry?.stage || entry))
    .filter(Boolean)
    .join("闂?) || "闂?;
}

function _getMonitorEjsStatusLabel(status = "") {
  const normalized = String(status || "").trim().toLowerCase();
  if (!normalized) return "";
  const labels = {
    primary: "濠电姷鏁搁崑鐐哄垂閸洖绠伴悹鍥у棘閿濆绠抽柡鍐ｅ亾鐎规洝灏欓埀顒€绠嶉崕鍗灻洪敃鍌氱；婵せ鍋撻柟顔斤耿閹瑩妫冨☉妤€顥氭俊?,
    fallback: "闂傚倸鍊烽悞锕傚箖閸洖纾块柟鎯版绾惧鏌曢崼婵愭Ц闁绘帒鐏氶妵鍕箣閿濆棭妫勬繛瀛樼矒缁犳牠寮婚埄鍐ㄧ窞闁糕剝蓱閻濇洟姊洪崨濠冣拹闁挎洏鍨芥俊瀛樼瑹閳ь剟鐛€ｎ喗鏅濋柍褜鍓涢悮?,
    failed: "濠电姷鏁搁崑鐐哄垂閸洖绠伴柛婵勫劤閻挾鐥幆褜鍎嶅ù婊冪秺閺岋紕浠︾拠鎻掑闂?,
  };
  return labels[normalized] || String(status || "");
}

function _formatMonitorRouteInfo(entry = {}) {
  const parts = [
    _getMonitorRouteLabel(entry?.route),
    _getMonitorRouteLabel(entry?.llmConfigSourceLabel),
    String(entry?.model || "").trim() ? `婵犵數濮烽。钘壩ｉ崨鏉戝瀭妞ゅ繐鐗嗛悞鍨亜閹哄棗浜剧紒鍓ц檸閸欏啴宕洪埀顒併亜閹烘垵鈧悂宕㈤幘顔界厸?{String(entry.model).trim()}` : "",
  ].filter(Boolean);
  const uniqueParts = [];
  for (const part of parts) {
    if (!uniqueParts.includes(part)) uniqueParts.push(part);
  }
  return uniqueParts.join(" 闂?") || "闂傚倸鍊风粈渚€骞栭锔藉亱婵犲﹤瀚々鏌ユ煥濠靛棭妯堥柡浣革躬閺屾盯濡烽鑽ゆ殫婵炲瓨绮岀紞濠囧蓟閿熺姴鐐婂瀣捣閿涚喖姊虹紒妯荤叆闁硅櫕锕㈠濠氭晲婢跺娼婇梺缁橆焾鐏忔瑧绮旈鐣岀闁挎繂鎳忛幖鎰版煥閺囥劋閭柣?;
}

function _summarizeMonitorGovernance(entry = {}) {
  const promptExecution = entry?.promptExecution || {};
  const worldInfo = promptExecution?.worldInfo || null;
  const regexInput = Array.isArray(promptExecution?.regexInput)
    ? promptExecution.regexInput
    : [];
  const requestCleaning = entry?.requestCleaning || null;
  const responseCleaning = entry?.responseCleaning || null;
  const persistence = entry?.batchStatus?.persistence || entry?.persistence || null;
  const lines = [];

  if (worldInfo) {
    lines.push(
      `濠电姷鏁搁崑鐐哄垂閸洖绠板┑鐘崇閸嬪绻濇繝鍌滃闁汇倗鍋撻妵鍕箛閸撲焦鍋ч梺? ${worldInfo.hit ? "闂傚倸鍊风粈渚€骞夐敍鍕煓闁圭儤顨呴崹鍌涚節闂堟侗鍎愰柛? : "闂傚倸鍊风粈渚€骞栭锔藉亱婵犲﹤瀚々鍙夌節婵犲倻澧曠紒鐘靛█閺屽秹鍩℃担鍛婃闂?} 闂?闂傚倸鍊风粈渚€骞夐敓鐘茬闁告縿鍎抽惌鎾绘煕椤愶絾绀冮柛?${Number(worldInfo.beforeCount || 0)} 闂?闂傚倸鍊风粈渚€骞夐敓鐘冲殞闁诡垼鐏愯ぐ鎺撳€婚柤鎭掑劚娴?${Number(worldInfo.afterCount || 0)} 闂?婵犵數濮烽弫鎼佸磿閹寸姴绶ら柦妯侯槺閺嗭附銇勯幒鎴濃偓鐢稿磻?${Number(worldInfo.atDepthCount || 0)}`,
    );
  }
  if (promptExecution?.ejsRuntimeStatus) {
    lines.push(`EJS: ${_getMonitorEjsStatusLabel(promptExecution.ejsRuntimeStatus)}`);
  }
  if (regexInput.length > 0) {
    const appliedRuleCount = regexInput.reduce(
      (sum, item) => sum + Number(item?.appliedRules?.length || 0),
      0,
    );
    lines.push(`闂傚倷绀侀幖顐λ囬鐐村亱濠电姴娲ょ粻浼存煙闂傚顦﹂柣顓燁殜閺屾盯鍩勯崘锔跨捕闂佸搫鐭夌粻鎾诲蓟閵堝棙鍙忛柟閭﹀厴閸嬫捇寮介鐐碉紮? ${regexInput.length} 婵?闂?闂傚倸鍊风粈渚€骞夐敍鍕煓闁圭儤顨呴崹鍌涚節闂堟侗鍎愰柛?${appliedRuleCount} 闂傚倸鍊风粈渚€骞栭位澶愭晸閻樺弬褔骞栧ǎ顒€鐏紒澶屽厴濮婄粯鎷呴崨濠傛殘闁汇埄鍨遍〃濠囧箖?;
  }
  if (requestCleaning) {
    lines.push(
      `闂傚倸鍊风粈渚€骞夐敓鐘冲仭闁挎洖鍊搁崹鍌炴煕瑜庨〃鍛存倿閸偁浜滈柟杈剧稻绾埖銇勯敂鑲╃暠妞ゎ叀鍎婚ˇ鏉戔攽椤旇姤灏﹀┑鈩冩尦楠炴帒螖閳ь剙顔忓┑鍥ヤ簻闁哄啫鍊藉鍛婁繆? ${requestCleaning.changed ? "闂傚倸鍊风粈渚€骞栭锔藉亱闁糕剝铔嬮崶銊ヮ嚤闁哄鍨堕悗顒佺節闂堟稑鈧鈥﹂崼銏㈢焼? : "闂傚倸鍊风粈渚€骞栭锕€鐤柣妤€鐗婇崣蹇涙煟閵忋埄鐒鹃柡瀣╃閳规垿宕掑搴ｅ姼缂備讲鍋?} 闂?闂傚倸鍊搁崐鎼佸磹閹间礁鐤柟鎯版閺勩儵鏌″搴″季闁?${_formatMonitorStageList(requestCleaning.stages)}`,
    );
  }
  if (responseCleaning) {
    lines.push(
      `闂傚倸鍊风粈渚€骞夐敍鍕床闁稿本绮庨惌鎾绘倵閸偆鎽冨┑顔藉▕閺岀喓绱掑Ο铏诡伝闂侀€炲苯澧悽顖椻偓宕囨殾闁靛ň鏅╅弫濠勭磽娴ｉ潧鐏悮? ${responseCleaning.changed ? "闂傚倸鍊风粈渚€骞栭锔藉亱闁糕剝铔嬮崶銊ヮ嚤闁哄鍨堕悗顒佺節闂堟稑鈧鈥﹂崼銏㈢焼? : "闂傚倸鍊风粈渚€骞栭锕€鐤柣妤€鐗婇崣蹇涙煟閵忋埄鐒鹃柡瀣╃閳规垿宕掑搴ｅ姼缂備讲鍋?} 闂?闂傚倸鍊搁崐鎼佸磹閹间礁鐤柟鎯版閺勩儵鏌″搴″季闁?${_formatMonitorStageList(responseCleaning.stages)}`,
    );
  }
  if (entry?.jsonFailure?.failureReason) {
    lines.push(`濠电姷鏁告慨浼村垂濞差亜纾块柤娴嬫櫅閸ㄦ繈鏌涢幘妤€瀚弸鍌炴⒑閹稿孩绀€闁稿﹥鎮傚畷鎺楀Ω閳哄倻鍘介梺鍝勫暙閻楀﹪寮潏鈺冪＜闁? ${String(entry.jsonFailure.failureReason || "")}`);
  }
  if (persistence) {
    lines.push(
      `闂傚倸鍊风粈浣虹礊婵犲洤鐤鹃柟缁樺俯濞撳鏌熼悜妯烩拻濞戞挸绉电换娑㈠幢濡纰嶇紓浣插亾? ${_formatPersistenceOutcomeLabel(persistence.outcome)} 闂?${String(persistence.storageTier || "none")}${persistence.reason ? ` 闂?${String(persistence.reason)}` : ""}`,
    );
  }
  return lines;
}

function _buildMonitorMessagesPreview(messages = []) {
  const text = _stringifyTraceMessages(messages);
  if (!text) return "";
  if (text.length <= 1800) return text;
  return `${text.slice(0, 1800)}\n\n...闂傚倸鍊烽悞锔锯偓绗涘懐鐭欓柟杈鹃檮閸嬪鏌涢埄鍐槈缂佲偓閸曨垱鐓ラ柣鏂挎惈瀛濈紓浣哄缁查箖濡甸崟顔剧杸闁圭偓娼欏▍銈夋⒑缂佹ê绗傜紒顔界懇瀵濡搁妷銏☆潔濠?
}

function _renderAiMonitorTraceCard(state) {
  const timeline = Array.isArray(state.taskTimeline) ? state.taskTimeline : [];
  if (state.settings?.enableAiMonitor !== true) {
    return `
      <div class="bme-config-card-title">濠电姷鏁搁崑娑㈩敋椤撶喐鍙忓Δ锝呭枤閺佸鎲告惔銊ョ疄闁靛ň鏅滈崑鍕煕韫囨洖甯堕柛鎿冨櫍濮婅櫣娑甸崨顔兼锭缂傚倸绉村Λ妤呪€﹂崶顒€绠虫俊銈勮兌閸橀亶姊洪幐搴ｇ畵闁哥噥鍋呮穱濠囨偩瀹€鈧壕鐓庛€掑顒婂姛闁伙綀椴搁妵?/div>
      <div class="bme-config-help">
        濠电姷鏁搁崑娑㈩敋椤撶喐鍙忓Δ锝呭枤閺佸鎲告惔銊ョ疄闁靛ň鏅滈崑鍕煕韫囨洖甯堕柛鎿冨櫍濮婅櫣娑甸崨顔兼锭缂傚倸绉村Λ妤呪€﹂崶顒€绠虫俊銈勮兌閸橀亶姊洪幐搴ｇ畵闁哥噥鍋呮穱濠囨嚃閳哄啰锛濋悗骞垮劚閹峰宕曢弮鍌楀亾鐟欏嫭绀冪紒顔肩焸椤㈡ɑ绺界粙鍨獩濡炪倖鎸鹃崑鐐侯敇婵傚憡鈷掑ù锝勮閻掑墽绱掔紒妯虹仸缂佺粯绋掔换婵嬪磻閼恒儳娲存鐐达耿椤㈡瑩宕叉径鍫濆姦闁哄本绋撴禒锕傚礈瑜夊Σ鍫ユ⒑閹颁椒绨介柡浣规倐閸┾偓妞ゆ帊绶￠崯蹇涙煕閻樺啿娴€规洘鍨块獮妯肩磼濡厧骞堟繝娈垮枟閿曗晠宕滃▎鎾冲惞閺夊牃鏅濈壕濂稿级閸稑濡跨紒鐘崇墬缁绘盯鎳濋柇锕€娈梺瀹狀嚙闁帮綁鐛鈧幖褰掝敃椤愨剝鍕冨┑鐘垫暩閸嬬偛顭囧▎鎾宠Е閻庯綆鍠楅崕妤併亜閺冨倸浜剧€规洖寮堕幈銊ノ熼崹顔惧帿闂佺顑傞弲婊呮崲濞戙垹骞㈡俊顖氭惈椤秵绻涚€电校闁挎洏鍨归锝夊醇閺囩偟鍘搁梺绋挎湰濮樸劍绂掗悡搴樻斀闁绘劘灏欐晶娑㈡煕閵娿儲鍋ラ柣娑卞櫍楠炴鎷犻懠顒傛澑婵＄偑鍊栧濠氬磻閹惧墎纾?/ 闂傚倸鍊风粈渚€骞夐敓鐘冲仭妞ゆ牜鍋涚粈鍫熺箾閸℃璐?/ 缂傚倸鍊搁崐鎼佸磹妞嬪海鐭嗗〒姘ｅ亾闁诡喗妞芥俊鎼佹晜閽樺浼庨梻渚€娼ф蹇曟閺囶潿鈧懘鎮滈懞銉ヤ化闂佹悶鍎崝宀€寰婄紒妯镐簻妞ゆ劗濮撮埀顒佺箞閹繝顢曢敃鈧悙濠囨偣妤︽寧銆冪紒銊ょ矙濮婃椽宕ㄦ繝鍕櫑闂備礁搴滅紞浣割嚕椤愩埄鍚嬮柛銉檮閸曞啴姊洪崗鑲┿偞闁哄倷绶氬顐﹀焵椤掆偓閳规垿鎮欓懠顒佹喖缂備緡鍠栭惉濂稿焵椤掍胶鈻撻柡鍛箞瀵偊顢氶埀顒勭嵁濡吋瀚氶柤鑹板煐閹蹭即姊绘笟鈧褔藝椤撱垹纾块梺顒€绉甸崑鍌炴煕瀹€鈧崑娑氱不瑜版帗鍊垫繛鎴烆伆閹寸姷鐭嗛柍褜鍓熼幃宄邦煥閸曨剛鍑￠梺绋匡工濠€杈╁垝鐎ｎ亶鍚嬪璺猴工閼板潡姊洪崫鍕窛濠殿喚鍏橀幃鐐哄礂閼测晝顔曢梺鐟邦嚟閸嬬偤鎮￠妷鈺傜厽婵°倐鍋撻悗姘嵆瀹曟椽鍩€椤掍降浜滈柟杈剧到閸旂敻鏌涜箛鎾剁劯闁哄备鍓濋幏鍛存濞戞帒浜鹃柡宥庡亞閻鈧箍鍎遍ˇ顖炵嵁閵忊€茬箚闁靛牆瀚崝宥夋煕閻樺磭鈯曠紒缁樼箞濡啫鈽夊Ο宄颁壕鐟滅増甯囬埀顒€鍟村畷鍗烆潩椤掍焦顔夐梻鍌氬€烽悞锕傚箖閸洖绀夌€光偓閸曞灚鏅為梺鍛婂姦閸犳牠鎮為崹顐犱簻闁硅揪绲剧涵鑸点亜閿旇偐鐣遍棁澶愭煟濡櫣锛嶉柍顖涙礈缁辨帡宕掑姣櫻呪偓瑙勬礀瀹曨剝鐏冩繛杈剧悼閹虫捇寮搁敃鈧埞鎴︽倷閼碱剚鎲肩紓渚囧枛缁夊墎鍒掑▎鎾崇闁哄啫鍊稿畷銉╂煟閻樺弶绌挎い銉ユ瀹曨偊宕熼崹顐㈢槣闂佽绻愮换鎴︽偋閺囩喓顩?
      </div>
    `;
  }

  if (!timeline.length) {
    return `
      <div class="bme-config-card-title">濠电姷鏁搁崑娑㈩敋椤撶喐鍙忓Δ锝呭枤閺佸鎲告惔銊ョ疄闁靛ň鏅滈崑鍕煕韫囨洖甯堕柛鎿冨櫍濮婅櫣娑甸崨顔兼锭缂傚倸绉村Λ妤呪€﹂崶顒€绠虫俊銈勮兌閸橀亶姊洪幐搴ｇ畵闁哥噥鍋呮穱濠囨偩瀹€鈧壕鐓庛€掑顒婂姛闁伙綀椴搁妵?/div>
      <div class="bme-config-help">
        闂傚倷绀侀幖顐λ囬锕€鐤炬繝濠傛閹冲矂姊绘担鍦菇闁稿酣浜堕獮濠偽熸笟顖氭闂佸壊鐓堥崑鍕閻愬樊鐔嗛悹杞拌閸庡繘骞栭弶鎴含婵﹥妞藉畷銊︾節閸愵亜骞愰梻浣告啞閹歌崵鎹㈤崟顓炲灊濠电姴娲﹂弲婵嬫煃瑜滈崜鐔兼晲閻愭祴鏀介柛鐙呯畱闁帮綁銆侀弽顓熷癄濠㈣泛顦ˉ姘舵⒒娴ｄ警鐒鹃柡鍫墰閸掓帗鎯旈妸銉ь啇婵犻潧鍊搁幉锟犳偂濞嗘垹纾藉ù锝咁潠椤忓懏鍙忛柛銉㈡櫆閸犳劙鏌℃径瀣嚋闁哥姵锚閳规垿鍨惧畷鍥ㄦ喖闂佺懓鍢查幊鎰垝濞嗘挸鍨傛い鏃傚亾椤旀垿姊婚崒娆戝妽闁诡喖鐖煎畷鏇㈠箮閽樺锛涢梺缁樺姇閹碱偊宕归崒鐐寸厪濠电倯鍐╁櫧闁挎稒绮撻弻锝嗘償閵忊懇濮囬梺鎸庢皑閹喖螣閼姐倗顔曢柣搴ｆ暩椤牓鐎锋俊鐐€栧▔锕傚礋椤掆偓瀵潡姊虹紒妯烩拻闁稿簺鍊曢悾閿嬪緞閹邦厾鍘甸柡澶婄墕婢т粙骞冮懖鈺冪＜闁绘ê纾晶顏堟煃閽樺妯€妤犵偞锕㈤、娑橆潩椤愩埄妫滈梻鍌欑閹碱偊藝闁秴纾块柟鐗堟緲缁愭鏌″搴″箹缂佺姵鐗楁穱濠囧Χ閸涱喖娅ら梺鍝勬媼閸撴盯鍩€椤掆偓閸樻粓宕戦幘缁樼厱闁规澘鍚€缁ㄨ姤銇勯弮鈧崝娆忣潖缂佹ɑ濯撮柣鐔稿缁佺兘姊洪崗鍏笺仧闁搞劋鍗抽敐鐐测攽鐎ｎ€晠鏌ㄩ弴妤€浜惧銈嗘礉妞存悂骞堥妸銉建闁糕剝顨呴～鈺佲攽椤曞棛鍒版い锔炬暬瀵鏁愰崪浣哄弳闂佸憡渚楅崣搴ㄥ汲椤撶偐鏀介柣鎰摠瀹曞嫰鏌涢埡鍌滃ⅹ妞ゎ厼娲︾换婵嗩潩椤掑偆鍚呴梻浣瑰缁诲倹顨ラ幖浣告瀬鐟滅増甯楅崑鈩冪節婵犲倹鍣规い锝呭悑缁绘盯骞撻幒鏃傤啋闂佺硶鏂侀崑?
      </div>
    `;
  }

  const cards = timeline
    .slice(-8)
    .reverse()
    .map((entry, idx) => {
      const summaryLines = _summarizeMonitorGovernance(entry);
      const previewText = _buildMonitorMessagesPreview(entry?.messages || []);
      const modelLabel =
        String(entry?.llmPresetName || "").trim() ||
        String(entry?.llmConfigSourceLabel || "").trim() ||
        String(entry?.model || "").trim() ||
        "闂傚倸鍊风粈渚€骞栭锔藉亱婵犲﹤瀚々鏌ユ煟閹邦喖鍔嬮柛瀣€块弻宥夊Ψ閿斿墽鐛梺缁樻⒒閸樠囨倶瀹曞洠鍋撶憴鍕婵炶尙濞€瀹?;
      const taskType = String(entry?.taskType || "unknown");
      const taskLabel = _getMonitorTaskTypeLabel(taskType);
      const status = String(entry?.status || "").toLowerCase();
      const dotClass = status.includes("error") || status.includes("fail")
        ? "dot-error"
        : status.includes("run")
          ? "dot-running"
          : "dot-success";
      const routeInfo = _formatMonitorRouteInfo(entry);

      // Governance tags
      const govTags = [];
      const pe = entry?.promptExecution || {};
      if (pe.worldInfo?.hit) govTags.push({ cls: "tag-worldinfo", label: `濠电姷鏁搁崑鐐哄垂閸洖绠板┑鐘崇閸嬪绻濇繝鍌滃闁汇倗鍋撻妵鍕箛閸撲焦鍋ч梺?${Number(pe.worldInfo.beforeCount || 0) + Number(pe.worldInfo.afterCount || 0) + Number(pe.worldInfo.atDepthCount || 0)}闂傚倸鍊风粈渚€骞栭位鍥ㄧ鐎ｎ亞顔?});
      if (pe.ejsRuntimeStatus) govTags.push({ cls: "tag-ejs", label: "EJS" });
      if (Array.isArray(pe.regexInput) && pe.regexInput.length) {
        const ruleCount = pe.regexInput.reduce((s, i) => s + Number(i?.appliedRules?.length || 0), 0);
        govTags.push({ cls: "tag-regex", label: `婵犵數濮甸鏍窗濡ゅ啯宕查柟閭﹀枛缁躲倕霉閻樺樊鍎忛柛?${ruleCount}闂傚倸鍊风粈渚€骞栭位鍥ㄧ鐎ｎ亞顔?});
      }
      if (entry?.requestCleaning?.changed) govTags.push({ cls: "tag-cleaning", label: "闂傚倸鍊风粈渚€骞夐敓鐘冲仭闁挎洖鍊搁崹鍌炴煕瑜庨〃鍛存倿閸偁浜滈柟杈剧稻绾爼鏌涢弬璺ㄐょ紒杈ㄥ浮瀵噣宕剁捄鐑橆唲闂? });
      if (entry?.responseCleaning?.changed) govTags.push({ cls: "tag-cleaning", label: "闂傚倸鍊风粈渚€骞夐敍鍕床闁稿本绮庨惌鎾绘倵閸偆鎽冨┑顔藉▕閺岀喓绱掑Ο铏诡伝闂侀€炲苯澧悽顖椻偓宕囨殾闁靛ň鏅╅弫濠勭磽娴ｉ潧鐏悮? });
      if (entry?.jsonFailure?.failureReason) govTags.push({ cls: "tag-error", label: "JSON濠电姷鏁告慨浼村垂濞差亜纾块柤娴嬫櫅閸ㄦ繈鏌涢幘妤€瀚弸? });

      const govTagsHtml = govTags.length
        ? `<div class="bme-ai-monitor-governance-tags">${govTags.map(t => `<span class="bme-ai-monitor-gov-tag ${t.cls}">${_escHtml(t.label)}</span>`).join("")}</div>`
        : "";

      const connector = idx < 7 ? `<div class="bme-ai-monitor-timeline-connector"></div>` : "";

      return `
        <div class="bme-ai-monitor-entry is-collapsed" data-bme-trace-idx="${idx}">
          <div class="bme-ai-monitor-entry__head">
            <div style="display:flex;align-items:center;gap:8px;flex:1;min-width:0">
              <div class="bme-ai-monitor-status-dot ${dotClass}"></div>
              <div style="min-width:0;flex:1">
                <div class="bme-ai-monitor-entry__title">${_escHtml(taskLabel)}
                  <span style="font-weight:400;opacity:0.5;font-size:11px;margin-left:4px">${_escHtml(_formatDurationMs(entry?.durationMs))}</span>
                </div>
                <div class="bme-ai-monitor-entry__meta">
                  ${_escHtml(
                    [
                      _getMonitorStatusLabel(entry?.status),
                      _formatTaskProfileTime(entry?.updatedAt),
                    ].filter(Boolean).join(" 闂?"),
                  )}
                </div>
              </div>
            </div>
            <span class="bme-task-pill">${_escHtml(modelLabel)}</span>
            <button class="bme-ai-monitor-entry__toggle" type="button" title="闂傚倷娴囬褏鎹㈤幒妤€纾婚柣鎰梿濞差亜鍐€妞ゆ劧缍嗗?闂傚倸鍊烽懗鍫曘€佹繝鍥ф槬闁哄稁鍘介弲顏堟煟?>
              <i class="fa-solid fa-chevron-down"></i>
            </button>
          </div>
          ${govTagsHtml}
          <div class="bme-ai-monitor-entry__detail">
            <div class="bme-config-help">${_escHtml(routeInfo)}</div>
            ${
              summaryLines.length
                ? `<div class="bme-ai-monitor-entry__summary">${summaryLines
                    .map((line) => `<div>${_escHtml(line)}</div>`)
                    .join("")}</div>`
                : ""
            }
            ${_renderMessageTraceTextBlock(
              "闂傚倸鍊风粈渚€骞栭锔藉亱闁告劦鍠栫壕濠氭煙閹冾暢缁炬崘妫勯湁闁挎繂鎳忛幉绋款熆瑜庡ú婊堝箟閹间礁绾ч柛顭戝枓閸嬫捇宕稿Δ鈧拑鐔兼煕濞戝崬鏋熷┑顖涙尦閺屾盯鏁傜拠鎻掕緟闂侀潧顦弲婊堟偂濞嗘劑浜滈柟鐐殔閸熺増绂掔粙娆炬富闁靛牆绻掑畝娑㈡煛閸涱喚绠炴?,
              previewText,
              "闂傚倷绀侀幖顐λ囬锕€鐤炬繝濠傜墛閸嬶繝鏌ㄩ弴妤€浜惧銈庡幖濞差參銆佸☉妯锋婵ê鍚嬬粊顐︽⒑閼姐倕孝婵炶绠掗妵鎰板礃椤曞棛绋忛梺闈涚墕濡稓绮绘ィ鍐╁€堕柣鎰問閻掓儳顭胯瀵墎鎹㈠┑瀣劦妞ゆ帊鑳堕悷褰掓煃瑜滈崜鐔兼偘椤曗偓楠炲鏁冮埀顒勫础閹惰姤鐓冮柕澶堝劤閿涘秵銇勯弬鎸庮棦婵﹥妞藉畷銊︾節閸屾粎鎳栨繝鐢靛О閸ㄦ椽鏁冮姀銈呯畺濡わ絽鍠氶弫鍡涙煕閺囥劌浜濋柣搴墴閺岋絾鎯旈妸锔介敪闂佺顕滅换婵嬪箖閻愵剚缍囬柕濞у拋鍟庨梻浣烘嚀閻°劎鎹㈤崟顒佹珷婵炴垶鈼よぐ鎺撳亗閹兼番鍨瑰▍銈夋⒑閹稿海鈯曢柛鏃€鐟ラ悾鐑芥偄绾拌鲸鏅梺鍛婁緱閸犳氨绮旀ィ鍐┾拻?,
            )}
          </div>
        </div>
        ${connector}
      `;
    })
    .join("");

  return `
    <div class="bme-config-card-head">
      <div>
        <div class="bme-config-card-title">濠电姷鏁搁崑娑㈩敋椤撶喐鍙忓Δ锝呭枤閺佸鎲告惔銊ョ疄闁靛ň鏅滈崑鍕煕韫囨洖甯堕柛鎿冨櫍濮婅櫣娑甸崨顔兼锭缂傚倸绉村Λ妤呪€﹂崶顒€绠虫俊銈勮兌閸橀亶姊洪幐搴ｇ畵闁哥噥鍋呮穱濠囨偩瀹€鈧壕鐓庛€掑顒婂姛闁伙綀椴搁妵?/div>
        <div class="bme-config-card-subtitle">
          闂傚倸鍊风粈渚€骞栭锔藉亱闁告劦鍠栫壕濠氭煙閹规劦鍤欑紒?${Math.min(timeline.length, 8)} 闂傚倸鍊风粈渚€骞栭位鍥敃閿曗偓閻掑灚銇勯幒鍡椾壕閻庢鍠涘▔娑㈡偩閻戣棄钃熼柕澶涘閸橀亶姊洪崫鍕偓浠嬪Υ閳ь剟鏌涚€ｎ偅宕岄柟鐓庣秺椤㈡洟濮€閿涘嫮鎳侀梻?闂?闂傚倸鍊烽懗鍓佸垝椤栫偛绀夋俊銈呮噹缁犵娀鏌熼幑鎰靛殭闁告俺顫夐妵鍕棘閸喚绋忓┑鐐茬焾娴滎亪寮婚敓鐘茬倞闁宠桨妞掗幋椋庣磼閻愵剙鍔ゆい顓犲厴瀵鏁嶉崟顏呭媰闁荤姴娲﹁ぐ鍐╂叏閵忕姭鏀介柣姗嗗亜娴滈箖姊洪崨濠佺繁闁搞劏浜埀顒佺瀹€鎼佸蓟閵娾晛绫嶉柛銉厛濡嫰姊?
        </div>
      </div>
      <span class="bme-task-pill">${_escHtml(String(timeline.length))} 闂?/span>
    </div>
    <div class="bme-ai-monitor-stack">
      ${cards}
    </div>
  `;
}


function _renderAiMonitorCognitionCard(state) {
  const graph = state.graph || null;
  const historyState = graph?.historyState || {};
  const regionState = graph?.regionState || {};
  const owners = _getCognitionOwnerCollection(graph);
  const latestRecallOwnerInfo = _getLatestRecallOwnerInfo(graph);
  const activeRegion = String(
    historyState.activeRegion ||
      historyState.lastExtractedRegion ||
      regionState.manualActiveRegion ||
      "",
  ).trim();
  const adjacentRegions = Array.isArray(regionState?.adjacencyMap?.[activeRegion]?.adjacent)
    ? regionState.adjacencyMap[activeRegion].adjacent
    : [];

  return `
    <div class="bme-config-card-head">
      <div>
        <div class="bme-config-card-title">闂傚倷娴囧畷鍨叏閹惰姤鈷旂€广儱顦壕瑙勪繆閵堝懏鍣洪柛?/ 缂傚倸鍊搁崐椋庣矆娓氣偓瀵敻顢楅埀顒勨€旈崘顔藉癄濠㈠厜鏅滈惄顖炵嵁閹邦厽鍎熸い顐幗閸炲姊绘担鍝ョШ闁稿锕畷瑙勭附缁嬭法鍝楁繛瀵稿Т椤戝洭宕ｉ幘缁樼厱闁靛鍔嶇涵鎯瑰鍛槐闁?/div>
        <div class="bme-config-card-subtitle">
          闂傚倷绀侀幖顐λ囬锕€鐤炬繝濠傜墛閸嬶繝鏌嶉崫鍕櫣闂傚偆鍨伴—鍐偓锝庝簽閸戣绻涘畝濠侀偗闁哄矉绻濆畷鍫曞煛娴ｅ洨鍋涢湁闁绘ê纾妴鎺楁煙閸欏鍊愰柟顔ㄥ洤閱囬柣鏃堫棑椤ｆ彃鈹戦悩顐ｅ闁告侗鍘搁弸鍛存⒑绾懏鐝繛鍙夘焽閹广垹鈹戠€ｎ亞锛滃┑鈽嗗灣閹虫捇宕甸柆宥嗏拻濞达絽鎲￠幆鍫ユ煟濡も偓閸熸潙鐣烽幋锕€绠荤紓浣诡焽閸樻悂姊虹粙鎸庢拱缂佸鍨块、鎾愁煥閸喓鍘靛銈嗙墬閿氶柍褜鍓氱换鍌炴偩閻戣姤鍊婚柦妯侯槺椤撶厧顪冮妶鍡樷拻闁哄拋鍋婂鎶芥偐缂佹鍘介梺缁橈耿娴滆泛顬婇悜鑺ョ厱濠电姴鍠氬▓婊堟煙椤曞棛绡€闁轰焦鎹囬幃鈺佺暦閸パ冩辈濠电姵顔栭崰妤呮晪閻庤娲﹂崜姘辩矉閹烘鏁嶉柣鎰嚟閸樺崬鈹戦悩璇у伐闁哥喍鍗抽幃姗€鏌嗗鍡欏帗闁荤喐鐟ョ€氼喗鏅堕崹顐ｅ弿濠电姴鎳庨崥鍦磼鏉堛劎鎳囬柟顔规櫊閹粙宕归銏℃濠电姷鏁搁崑鐐哄垂閸洖绠伴柟闂寸贰閺佸嫰鏌涢埄鍐槈闁告垹濞€閺屾盯骞囬棃娑欑亶闂佸搫鎷嬮崜鐔煎箖濮椻偓閹瑧鎹勬潪鐗堢潖闂備浇宕甸崰鎰崲閸儱钃熸繛鎴欏灩缁犳稒銇勯幒鎴濃偓鎰槼缂佺粯绋撻崰濠囧础閻愭祴鎷柣搴ゎ潐濞叉鍒掑畝鍕垫晣濠靛倻顭堥悙濠囨煛閸垺鏆╃痪鎹愭閳规垿鎮欓弶鎴犱桓闂佺懓鎲￠幃鍌炲箖濞差亜惟闁靛鍠楃€靛矂姊虹粙璺ㄧ伇闁稿鍋ゅ畷鎴﹀冀閵娧呯槇閻熸粌绉堕懞閬嶆焼瀹ュ懐锛?
        </div>
      </div>
    </div>
    <div class="bme-ai-monitor-kv">
      <div class="bme-ai-monitor-kv__row">
        <span>闂備浇宕甸崰鎰垝鎼淬垺娅犳俊銈呮噹缁犱即鏌涘☉姗堟敾婵炲懐濞€閺岋絽螣濞嗘儳娈梺鍦嚀閻栧ジ寮婚敐澶婄闁绘劕妫欓崹鍧楀箖閻㈠壊鏁嶉柣鎰ˉ閹锋椽姊洪崷顓х劸閻庢稈鏅犻幆鍐箣閿旂晫鍘?/span>
        <strong>${_escHtml(
          latestRecallOwnerInfo.ownerLabels.length > 0
            ? latestRecallOwnerInfo.ownerLabels.join(" / ")
            : "闂?,
        )}</strong>
      </div>
      <div class="bme-ai-monitor-kv__row">
        <span>闂傚倸鍊烽懗鍫曗€﹂崼銏″床闁圭儤顨呴崒銊ф喐閺冨牄鈧礁鈻庨幘宕囩杸闂佸搫顦冲▔鏇㈡儓閸曨垱鍋℃繝濠傚椤ュ牏鈧鍣崑鍡涘焵椤掑﹦绉甸柛鐘愁殜瀹?/span>
        <strong>${_escHtml(
          Array.isArray(historyState.recentRecallOwnerKeys) &&
            historyState.recentRecallOwnerKeys.length
            ? historyState.recentRecallOwnerKeys.join(" / ")
            : "闂?,
        )}</strong>
      </div>
      <div class="bme-ai-monitor-kv__row">
        <span>闂備浇宕甸崰鎰垝鎼淬垺娅犳俊銈呮噹缁犱即鏌涘☉姗堟敾婵炲懐濞€閺岋絽螣濞嗘儳娈梺鍦嚀閻栧ジ寮婚埄鍐ㄧ窞濠电姴瀚搹搴ㄦ⒒?/span>
        <strong>${_escHtml(
          activeRegion
            ? `${activeRegion}${
                historyState.activeRegionSource
                  ? ` 闂?${historyState.activeRegionSource}`
                  : ""
              }`
            : "闂?,
        )}</strong>
      </div>
      <div class="bme-ai-monitor-kv__row">
        <span>闂傚倸鍊搁崐椋庢閿熺姴鍌ㄩ柛鎾楀啫鐏婂銈嗙墬缁秹寮冲鍫熺厵缂備降鍨归弸娑㈡煙閻熸壆鍩ｉ柡灞稿墲瀵板嫭绻濋崟顏囨闂?/span>
        <strong>${_escHtml(adjacentRegions.length ? adjacentRegions.join(" / ") : "闂?)}</strong>
      </div>
      <div class="bme-ai-monitor-kv__row">
        <span>闂傚倷娴囧畷鍨叏閹惰姤鈷旂€广儱顦壕瑙勪繆閵堝懏鍣洪柛瀣€块弻銊モ槈濡警浠鹃梺鍝ュТ濡繈寮婚悢鍏煎€绘俊顖濆吹椤︺儱顪冮妶鍐ㄥ姎缂佺粯锕㈠?/span>
        <strong>${_escHtml(String(owners.length || 0))}</strong>
      </div>
      <div class="bme-ai-monitor-kv__row">
        <span>闂傚倸鍊风粈渚€骞栭锔藉亱闁告劦鍠栫壕濠氭煙閸撗呭笡闁绘挻娲橀幈銊ヮ潨閸℃顫╁銈嗗竾閸ㄥ骞夐崨濠忕矗濞达綀娅ｉ悰銏ゆ倵鐟欏嫭绌跨紓宥勭椤曪綁宕愰悤浣剐梻浣告啞濞茬喓绮婚弽顓炶摕?/span>
        <strong>${_escHtml(String(historyState.lastExtractedRegion || "闂?))}</strong>
      </div>
    </div>
  `;
}

function _renderMessageTraceTextBlock(title, text, emptyText = "闂傚倸鍊风粈渚€骞栭鈶芥稑螖閸涱厾锛欓梺鑽ゅ枑鐎氬牆鈽夐姀鐘栄冾熆鐠虹尨鍔熸い锔哄姂濮婃椽宕ㄦ繝浣虹箒闂佸憡鐟ラ柊锝呯暦?) {
  const normalized = String(text || "").trim();
  return `
    <div class="bme-task-section-label">${_escHtml(title)}</div>
    ${
      normalized
        ? `<pre class="bme-debug-pre">${_escHtml(normalized)}</pre>`
        : `<div class="bme-debug-empty">${_escHtml(emptyText)}</div>`
    }
  `;
}

function _normalizeDebugMessages(messages = []) {
  if (!Array.isArray(messages)) return [];

  return messages
    .map((message) => {
      if (!message || typeof message !== "object") return null;
      const role = String(message.role || "").trim().toLowerCase();
      const content = String(message.content || "").trim();
      if (!role || !content) return null;
      return { role, content };
    })
    .filter(Boolean);
}

function _stringifyTraceMessages(messages = []) {
  const normalizedMessages = _normalizeDebugMessages(messages);
  if (!normalizedMessages.length) return "";

  return normalizedMessages
    .map(
      (message) => `闂?{_getMonitorRoleLabel(message.role)}闂傚倸鍊风欢姘焽瑜嶈灋婵炲棙鎸搁惌妤佹叏?{message.content}`,
    )
    .join("\n\n---\n\n");
}

function _buildMainAiTraceText(triggeredUserMessage = "", injectionText = "") {
  const sections = [];
  const normalizedUserMessage = String(triggeredUserMessage || "").trim();
  const normalizedInjectionText = String(injectionText || "").trim();

  if (normalizedUserMessage) {
    sections.push(`闂傚倸鍊风欢姘焽瑜嶈灋婵炲棙鎸哥粈澶嬩繆閵堝懏鍣归柡瀣╃窔閺屾洟宕煎┑鎰︾紓浣哄缂嶄線寮婚敍鍕ㄥ亾閿濆娑уù婊勫姍閺屾稓鈧綆鍋呭畷灞绢殽閻愯尙澧﹂柟?{normalizedUserMessage}`);
  }
  if (normalizedInjectionText) {
    sections.push(`闂傚倸鍊风欢姘焽瑜嶈灋婵炲棙鎸哥粈澶嬫叏濡炶浜惧銈冨灪閻熲晛鐣烽崼鏇ㄦ晜闁糕剝鐟﹀鎴︽⒒娴ｈ櫣銆婇柛鎾寸箚閹筋偊姊洪崫鍕棞闁绘鎹囧璇测槈濠婂懐鏉搁柣搴秵娴滄粍鎱ㄥ畝鍕拺闂侇偆鍋涢懟顖涙櫠椤栫偞鐓曟繛鍡樺姦閸?{normalizedInjectionText}`);
  }

  return sections.join("\n\n---\n\n").trim();
}

function _buildTraceMessagePayloadText(messages = [], promptBuild = null) {
  const normalizedMessages = _normalizeDebugMessages(messages);
  if (normalizedMessages.length) {
    return _stringifyTraceMessages(normalizedMessages);
  }

  const fallbackMessages = [];
  const fallbackSystemPrompt = String(promptBuild?.systemPrompt || "").trim();
  if (fallbackSystemPrompt) {
    fallbackMessages.push({ role: "system", content: fallbackSystemPrompt });
  }

  for (const message of promptBuild?.privateTaskMessages || []) {
    if (!message || typeof message !== "object") continue;
    const role = String(message.role || "").trim().toLowerCase();
    const content = String(message.content || "").trim();
    if (!role || !content) continue;
    fallbackMessages.push({ role, content });
  }

  return _stringifyTraceMessages(fallbackMessages);
}

function _extractTriggeredUserMessageFromRecentMessages(recentMessages = []) {
  if (!Array.isArray(recentMessages)) return "";

  for (let index = recentMessages.length - 1; index >= 0; index--) {
    const line = String(recentMessages[index] || "").trim();
    if (!line) continue;
    if (line.startsWith("[user]:")) {
      return line.replace(/^\[user\]:\s*/i, "").trim();
    }
  }
  return "";
}

function _patchTaskProfiles(taskProfiles, extraPatch = {}, options = {}) {
  return _patchSettings(
    {
      taskProfilesVersion: 3,
      taskProfiles,
      ...extraPatch,
    },
    {
      refreshTaskWorkspace: options.refresh !== false,
    },
  );
}

async function _handleTaskProfileWorkspaceClick(event) {
  const actionEl = event.target.closest("[data-task-action]");
  if (!actionEl) return;

  const action = actionEl.dataset.taskAction || "";
  const state = _getTaskProfileWorkspaceState();
  const selectedProfile = state.profile;
  if (
    !selectedProfile &&
    action !== "switch-task-type" &&
    action !== "switch-global-regex"
  ) return;

  switch (action) {
    case "switch-task-type":
      currentTaskProfileTaskType =
        actionEl.dataset.taskType || currentTaskProfileTaskType;
      showGlobalRegexPanel = false;
      currentTaskProfileBlockId = "";
      currentTaskProfileRuleId = "";
      _refreshTaskProfileWorkspace();
      return;
    case "switch-global-regex":
      showGlobalRegexPanel = true;
      _refreshTaskProfileWorkspace();
      return;
    case "switch-task-tab":
      currentTaskProfileTabId =
        actionEl.dataset.taskTab || currentTaskProfileTabId;
      _refreshTaskProfileWorkspace();
      return;
    case "refresh-task-debug":
      if (typeof _getRuntimeDebugSnapshot === "function") {
        _getRuntimeDebugSnapshot({ refreshHost: true });
      }
      _refreshTaskProfileWorkspace();
      return;
    case "inspect-tavern-regex":
      await _openRegexReuseInspector(state.taskType);
      return;
    case "select-block":
      currentTaskProfileBlockId = actionEl.dataset.blockId || "";
      _refreshTaskProfileWorkspace();
      return;
    case "toggle-block-expand": {
      // Ignore if the click originated from a toggle switch, delete button, or drag handle
      const originEl = event.target;
      if (originEl.closest(".bme-task-row-toggle") || originEl.closest(".bme-task-row-btn-danger") || originEl.closest(".bme-task-drag-handle")) {
        return;
      }
      const blockId = actionEl.dataset.blockId || "";
      if (currentTaskProfileBlockId === blockId) {
        currentTaskProfileBlockId = "";
      } else {
        currentTaskProfileBlockId = blockId;
      }
      _refreshTaskProfileWorkspace();
      return;
    }
    case "toggle-regex-rule-expand": {
      const originEl = event.target;
      if (
        originEl.closest(".bme-task-row-toggle") ||
        originEl.closest(".bme-task-row-btn-danger") ||
        originEl.closest(".bme-regex-drag-handle")
      ) {
        return;
      }
      const ruleId = actionEl.dataset.ruleId || "";
      if (_isGlobalRegexPanelTarget(actionEl)) {
        currentGlobalRegexRuleId =
          currentGlobalRegexRuleId === ruleId ? "" : ruleId;
      } else {
        currentTaskProfileRuleId =
          currentTaskProfileRuleId === ruleId ? "" : ruleId;
      }
      _refreshTaskProfileWorkspace();
      return;
    }
    case "select-regex-rule":
      if (_isGlobalRegexPanelTarget(actionEl)) {
        currentGlobalRegexRuleId = actionEl.dataset.ruleId || "";
      } else {
        currentTaskProfileRuleId = actionEl.dataset.ruleId || "";
      }
      _refreshTaskProfileWorkspace();
      return;
    case "add-custom-block":
      _updateCurrentTaskProfile((draft, context) => {
        const nextBlock = createCustomPromptBlock(context.taskType, {
          name: `闂傚倸鍊烽懗鍫曞储瑜旈妴鍐╂償閵忋埄娲稿┑鐘诧工閻楀﹪宕戦埡鍛厽闁逛即娼ф晶浼存煃缂佹ɑ绀€妞ゎ叀娉曢幑鍕偖鐎涙ɑ鏆伴梻?${draft.blocks.length + 1}`,
          order: draft.blocks.length,
        });
        draft.blocks.push(nextBlock);
        return { selectBlockId: nextBlock.id };
      });
      return;
    case "add-builtin-block": {
      const select = document.getElementById("bme-task-builtin-select");
      const sourceKey = String(select?.value || "").trim();
      if (!sourceKey) {
        toastr.info("闂傚倸鍊烽懗鍫曗€﹂崼銏″床闁规壆澧楅崑瀣煙閹规劦鍤欓柣鎺戠仛閵囧嫰骞掗崱妞惧婵＄偑鍊ч梽鍕珶閸℃稑鐒垫い鎺嶇閹兼悂鏌涢弬璺ㄐょ紒顔界懄瀵板嫰骞囬鍌氬Е婵＄偑鍊栫敮濠囨嚄閸洖鐓濋柡鍐ｅ亾闁靛洤瀚粻娑㈠箻閹颁椒鎮ｉ梻浣芥〃缁€浣规櫠鎼达絾顫曢柟鎹愵嚙缁€鍐煙椤栧棗瀚禍顏呯節閻㈤潧浠ч柕鍡楊儑閹广垹鈹戦崱鈺佹闂佸壊鍋呭ú鏍ф暜闂備焦瀵ч弻銊︽櫠娴犲鏄?, "ST-BME");
        return;
      }
      _updateCurrentTaskProfile((draft, context) => {
        const nextBlock = createBuiltinPromptBlock(context.taskType, sourceKey, {
          order: draft.blocks.length,
        });
        draft.blocks.push(nextBlock);
        return { selectBlockId: nextBlock.id };
      });
      return;
    }
    case "move-block-up":
      _moveTaskBlock(actionEl.dataset.blockId, -1);
      return;
    case "move-block-down":
      _moveTaskBlock(actionEl.dataset.blockId, 1);
      return;
    case "toggle-block-enabled":
      _updateCurrentTaskProfile((draft) => {
        const blocks = _sortTaskBlocks(draft.blocks);
        const block = blocks.find((item) => item.id === actionEl.dataset.blockId);
        if (!block) return null;
        block.enabled = block.enabled === false;
        draft.blocks = _normalizeTaskBlocks(blocks);
        return { selectBlockId: block.id };
      });
      return;
    case "toggle-block-enabled-cb":
      _updateCurrentTaskProfile((draft) => {
        const blocks = _sortTaskBlocks(draft.blocks);
        const block = blocks.find((item) => item.id === actionEl.dataset.blockId);
        if (!block) return null;
        block.enabled = actionEl.checked;
        draft.blocks = _normalizeTaskBlocks(blocks);
        return { selectBlockId: currentTaskProfileBlockId };
      });
      return;
    case "delete-block":
      _deleteTaskBlock(actionEl.dataset.blockId);
      return;
    case "save-profile":
      _patchTaskProfiles(state.taskProfiles, {}, { refresh: true });
      toastr.success("闂備浇宕甸崰鎰垝鎼淬垺娅犳俊銈呮噹缁犱即鏌涘☉姗堟敾婵炲懐濞€閺岋絽螣绾板崬濮曠紓浣瑰敾缂嶄線寮诲☉銏犲嵆闁靛鍎查悵顕€姊洪崫銉ユ瀻婵炲鍏橀崺鈧い鎺戝枤濞兼劙鏌ｉ埄鍐╃妞ゆ洩缍侀獮姗€鎳滈棃娑樼哎婵犳鍠楄摫濠⒀冮叄瀹?, "ST-BME");
      return;
    case "rename-profile": {
      const current = String(selectedProfile?.name || "").trim();
      const nextName = window.prompt("闂傚倷娴囧畷鍨叏閺夋嚚娲Ω閳轰浇鎽曟繝銏ｆ硾閺堫剟顢曢懞銉ｄ簻闁规儳宕悘鈺冪磼閳ь剟宕掗悙瀵稿帾婵犮垼娉涘Λ娆忊枍閹剧粯鐓涢柛鈩兩戠粈瀣煙椤旀娼愰柟宄版嚇閹兘寮堕崹顔ф垿姊绘担绛嬪殐闁哥姵顨呯叅婵犲﹤鎳庨崹?, current);
      if (nextName == null) return;
      const trimmed = String(nextName).trim();
      if (!trimmed) {
        toastr.info("濠电姷顣藉Σ鍛村磻閸涱収鐔嗘俊顖氱毞閸嬫挸顫濋悡搴ｄ桓濡炪們鍨洪悷鈺侇嚕閹绢喖顫呴柣妯兼磪閺囥垺鍊垫鐐茬仢閸旀碍绻涙径娑氱暤闁诡喗鐟ч埀顒傛暩绾爼寮搁弽顓熷€垫鐐茬仢閸旀岸鏌ｅΔ鈧Λ婵嗙暦閵忋倕绾ч柟瀛樻⒐椤秹姊虹憴鍕妞ゎ偄顦甸、鏃堟偐缂佹鍘?, "ST-BME");
        return;
      }
      _updateCurrentTaskProfile((draft) => {
        draft.name = trimmed;
      });
      toastr.success("濠电姷顣藉Σ鍛村磻閸涱収鐔嗘俊顖氱毞閸嬫挸顫濋悡搴ｄ桓濡炪們鍨洪悷鈺侇嚕閹绢喖顫呴柣妯兼磪閺囥垺鍊垫鐐茬仢閸旀碍绻涙径娑氱暤闁诡喗鐟ラ蹇涱敊閸忓吋鐝氶梻鍌欑閹诧繝鎮烽妷鈹у洭骞嶉鐐紡濡炪倖鐗滈崑鐐烘偂?, "ST-BME");
      return;
    }
    case "save-as-profile": {
      const suggestedName = `${selectedProfile.name || "濠电姷顣藉Σ鍛村磻閸涱収鐔嗘俊顖氱毞閸嬫挸顫濋悡搴ｄ桓濡?} 闂傚倸鍊风粈渚€骞夐敓鐘茬闁冲搫鎳庨崹鍌炴煕濡ゅ啫鍓抽柤鏉挎健閺?
      const nextName = window.prompt("闂傚倷娴囧畷鍨叏閺夋嚚娲Ω閳轰浇鎽曟繝銏ｆ硾閺堫剟顢曢懞銉ｄ簻闁规儳宕悘鈺冪磼閳ь剟宕掗悙瀵稿帾婵犮垼鍩栭惄顖氼瀶椤曗偓閺岋綁骞橀姘濠电姷顣藉Σ鍛村磻閸涱収鐔嗘俊顖氱毞閸嬫挸顫濋悡搴ｄ桓濡炪們鍨洪悷鈺侇嚕閹绢喖顫呴柣妯兼磪閺囥垺鍊垫鐐茬仢閸旀碍绻?, suggestedName);
      if (nextName == null) return;
      const trimmedName = String(nextName).trim();
      if (!trimmedName) {
        toastr.info("濠电姷顣藉Σ鍛村磻閸涱収鐔嗘俊顖氱毞閸嬫挸顫濋悡搴ｄ桓濡炪們鍨洪悷鈺侇嚕閹绢喖顫呴柣妯兼磪閺囥垺鍊垫鐐茬仢閸旀碍绻涙径娑氱暤闁诡喗鐟ч埀顒傛暩绾爼寮搁弽顓熷€垫鐐茬仢閸旀岸鏌ｅΔ鈧Λ婵嗙暦閵忋倕绾ч柟瀛樻⒐椤秹姊虹憴鍕妞ゎ偄顦甸、鏃堟偐缂佹鍘?, "ST-BME");
        return;
      }
      const nextProfile = cloneTaskProfile(selectedProfile, {
        taskType: currentTaskProfileTaskType,
        name: trimmedName,
      });
      currentTaskProfileBlockId = nextProfile.blocks?.[0]?.id || "";
      currentTaskProfileRuleId = nextProfile.regex?.localRules?.[0]?.id || "";
      const nextTaskProfiles = upsertTaskProfile(
        state.taskProfiles,
        currentTaskProfileTaskType,
        nextProfile,
        { setActive: true },
      );
      _patchTaskProfiles(nextTaskProfiles);
      toastr.success("闂備浇顕уù鐑藉箠閹捐绠熼梽鍥Φ閹版澘绀冩い鎾寸矆濮规姊虹紒妯活梿闁靛棌鍋撻梺绋款儐閹告悂鍩ユ径濞炬瀺妞ゆ挴鈧厖姹楅梺鐟板槻缂嶅﹪骞冮姀銈嗗亗閹兼番鍩勫Λ鐔封攽閻愬瓨缍戦柛姘儔楠炲棗鐣濋崟顐ｈ緢闂佸搫娲㈤崹娲磻?, "ST-BME");
      return;
    }
    case "export-profile":
      _downloadTaskProfile(
        state.taskProfiles,
        currentTaskProfileTaskType,
        selectedProfile,
        state.globalTaskRegex,
      );
      return;
    case "import-profile":
      document.getElementById("bme-task-profile-import")?.click();
      return;
    case "export-all-profiles":
      _downloadAllTaskProfiles(state.taskProfiles, state.globalTaskRegex);
      return;
    case "import-all-profiles":
      document.getElementById("bme-task-profile-import-all")?.click();
      return;
    case "restore-all-profiles": {
      const confirmed = window.confirm(
        "闂傚倷绀侀幖顐λ囬锕€鐤炬繝濠傜墛閸嬶繝鏌曢崼婵囧妞ゎ偅娲熼弻鐔封枔閸喗鐏嗛梺缁樺笒閿曨亪寮诲☉銏犵労闁告劗鍋撻悾鍫曟倵濞堝灝鏋涙繛灏栤偓鎰佹綎?6 濠电姷鏁搁崑鐐哄垂閸洖绠归柍鍝勫€婚々鍙夌箾閸℃ɑ灏紒鐘崇叀閺屾洝绠涚€ｎ亖鍋撻弴鐘电焼濠㈣埖鍔栭悡銉︾箾閹寸伝顏堫敂椤忓牊鐓熼柨婵嗘噹閼歌銇勯锝庢當闁宠棄顦埢搴∥熼悡搴⌒┑锛勫亼閸婃牠骞愰崜褍鍨濇い鏍仦閺咁剟鏌熼悧鍫熺凡缂佲偓鐎ｎ偁浜滈柡鍥╁仦閸ｅ綊鏌￠崪浣稿籍婵﹨娅ｉ幏鐘诲灳閸愯尙顔夐梻浣规偠閸斿瞼绱炴繝鍛棨闂備礁鎲￠悷銉┧囬柆宥呯厺闁哄啫鐗婇悡鏇熺節闂堟稒顥滄い蹇婃櫆閹便劑鏁愰崪浣光枅闂佸搫鏈粙鎴ｇ亽闂佸憡绻傜€氀囧磻閹惧墎纾兼俊顖濐嚙瀵潡姊鸿ぐ鎺擄紵缂佲偓娴ｈ櫣涓嶉柟瀛樼贩瑜版帗鏅查柛銉ㄥ煐濮ｅ矂姊虹粙娆惧剱闁圭懓娲ら悾鐑藉箳閹搭厽鍍靛銈嗗坊閸嬫挻绻涢崼娑樺姕缂佺粯鐩弫鎰板川椤旂⒈妲辩紓鍌欐祰椤曆囧磹閸ф绠栨繛宸簻鎯熼梺鍐叉惈閸婃悂宕滈銏♀拺闁告稑锕ユ径鍕煕閻樺磭澧柍缁樻尰鐎佃偐鈧稒锚閳ь剛鏁婚幃宄扳枎韫囨搩浼€闂佺粯鎼╅崹宕囨閹烘鍋愰梻鍫熺⊕閻庨箖姊洪幐搴ｂ姇闁告梹鐟ラ悾鐑芥偄绾拌鲸鏅梺鍛婁緱閸樿棄鈻嶅Δ鈧埞鎴︽倷閺夋垹浠搁梺鍦焾閹芥粎鍒掗弮鍌氼棜閻庯絻鍔嬪Ч妤呮⒑閸撴彃浜剧紒鑼帛缁傚秷銇愰幒鎾跺幈濠德板€曢崯顐ｇ閿曞倹鐓欐い鏍ㄧ〒閹冲洭鏌＄仦璇插闁宠棄顦灒闁兼祴鏅涙慨閬嶆⒒娓氣偓閳ь剛鍋涢懟顖涙櫠椤栨稒鍙忔俊顖滎焾婵倻鈧鍣崑濠冧繆閸洖妞藉ù锝堫潐閵嗗啴姊绘担鐟邦嚋缂佽鍊块獮濠冩償閵婏箑鈧爼鏌ｉ弬鍨倯闁稿鍓濈换娑㈠幢濡ゅ啰顔囧銈呯箚閺呯娀寮诲☉鈶┾偓锕傚箣濠靛牅鐢荤紓鍌欑椤戝懘鏁冮鍫濈畺闁靛繈鍊曠粈鍫澝归敐鍥у妺闁哥姵甯″缁樻媴閸涘﹤鏆堥梺鑽ゅ櫐缁犳捇濡撮崘顔煎窛妞ゆ棃绠栧顕€姊洪崫鍕枆闁告ê鍚嬬€靛ジ鎮╃喊妯轰壕妤犵偛鐏濋崝姘舵煕閻斿搫鈻堢€规洘鍨块獮妯兼嫚閼碱剨绱叉繝鐢靛仦閸ㄥ爼顢旈悜鑺ユ櫇闁稿本绋撻崢鍗炩攽椤旂即鎴﹀磿閹跺鈧懘顢楅崟顒傚幍闂佸湱铏庨崳顔嘉涢幋鐘电＜閺夊牄鍔屽ù顔姐亜閵忊槄鑰垮┑鈩冪摃椤︽煡鏌?,
      );
      if (!confirmed) return;
      const taskTypes = getTaskTypeOptions().map((t) => t.id);
      let restored = state.taskProfiles;
      const extraPatch = {};
      for (const tt of taskTypes) {
        restored = restoreDefaultTaskProfile(restored, tt);
        const lf = getLegacyPromptFieldForTask(tt);
        if (lf) extraPatch[lf] = "";
      }
      currentTaskProfileBlockId = "";
      currentTaskProfileRuleId = "";
      _patchTaskProfiles(restored, extraPatch);
      toastr.success(`闂備浇顕ф绋匡耿闁秮鈧箓宕煎┑鎰闂佺厧鎽滈弫鎼併€呴柨瀣ㄤ簻闁哄啫娲﹂ˉ澶岀磼閸撲礁浠ч柍褜鍓欑粻宥夊磿闁秴绠犻幖绮规閸ゆ洟鏌涜椤ㄥ棝鍩?${taskTypes.length} 濠电姷鏁搁崑鐐哄垂閸洖绠归柍鍝勫€婚々鍙夌箾閸℃ɑ灏紒鐘崇叀閺屾洝绠涚€ｎ亖鍋撻弴鐘电焼濠㈣埖鍔栭悡銉︾箾閹寸伝顏堫敂椤忓牊鐓熼柨婵嗘噹閼歌銇勯锝庢當闁宠棄顦埢搴∥熼悡搴⌒┑锛勫亼閸婃牠骞愰崜褍鍨濇い鏍仦閺咁剟鏌熼悧鍫熺凡缂佲偓鐎ｎ偁浜滈柡鍥╁仦閸ｅ綊鏌￠崨顖涘, "ST-BME");
      return;
    }
    case "restore-default-profile": {
      const confirmed = window.confirm(
        "闂傚倷绀侀幖顐λ囬锕€鐤炬繝濠傜墛閸嬶繝鏌曢崼婵囧妞ゎ偅娲栭湁闁绘挸娴烽幗鐘绘煟閹惧啿鈧鍩€椤掆偓缁犲秹宕曢柆宥呯疇闁归偊鍠楅～鏇㈡煥閺冨倸浜鹃柛鐘冲姍閺岋絽螖閳ь剟鎮ф繝鍕剨妞ゆ挾鍎愰悢鍡欐喐韫囨梹鍙忛柣銏㈡暩閻鏌熼悜妯烩拹閻庢碍宀搁弻鐔虹磼濡桨鍒婂┑鐐插悑婵炲﹤顫忛崫鍕懷囧炊瑜嶉‖鍫ユ煟鎼淬垻顣插鐟版瀹曟岸骞掑Δ濠冩櫖濠电姴锕ょ€氼剟顢撳☉銏♀拺闂傚牊绋撴晶鏇熴亜閿旇法鐭欑€殿喗濞婂鎾閳ュ厖鍖栧┑鐐舵彧缂嶁偓妞ゎ偄顦遍埀顒佺濞叉粎妲愰幒鎾寸秶闁靛ě鍛澖闂備胶绮笟妤呭窗濮樿泛绠查柛鏇ㄥ灠娴肩娀鏌涢弴銊ュ箰闁稿鎸荤缓浠嬪川婵犲嫬骞嶆俊銈囧Х閸嬫盯鎮樺┑瀣€堕柍鍝勬噺閻撴洟鏌嶆潪鎵妽婵犫偓閻楀牄浜滄い蹇庣娴滅偓绻濈喊妯活潑闁搞劑浜堕、鏍р枎閹惧疇袝闂佹悶鍎洪悘娑樷槈閵忕姷楠囬梺鍓茬厛閸ｎ喗瀵奸崒姘兼富闁靛牆妫欓埛鎰箾閼碱剙鏋戝ǎ鍥э躬楠炴﹢顢欓懖鈺嬬床婵犵數鍋為崹鍫曨敂閻戣姤鏅濋柛灞剧〒閸樺崬鈹戦缂存垿宕曢幎濮愨偓鍛搭敆閸曨剛鍘甸梺鍦檸閸ｎ喖螞閹寸姷纾奸弶鍫涘妼濞搭喗銇勯姀鈽呰€垮┑鈩冪摃椤︽煡鏌?,
      );
      if (!confirmed) return;
      const nextTaskProfiles = restoreDefaultTaskProfile(
        state.taskProfiles,
        currentTaskProfileTaskType,
      );
      const legacyField = getLegacyPromptFieldForTask(currentTaskProfileTaskType);
      currentTaskProfileBlockId = "";
      currentTaskProfileRuleId = "";
      _patchTaskProfiles(
        nextTaskProfiles,
        legacyField ? { [legacyField]: "" } : {},
      );
      toastr.success("濠电姵顔栭崰妤冩暜濡ゅ啰鐭欓柟鐑樸仜閳ь剨绠撳畷濂稿Ψ椤旇姤娅嶇紓鍌氬€烽悞锕傛晝椤愩倖顫曢柨婵嗩槹閻撴洟鏌￠崶銉ュ婵炲懏锕㈤弻娑㈡偄闁垮宕抽梺閫炲苯澧繝鈧柆宥佲偓锕傚醇濠垫劕娈ㄩ梺鐓庢憸閺佹悂銆呴柨瀣ㄤ簻闁哄啫娲﹂ˉ澶岀磼?, "ST-BME");
      return;
    }
    case "add-regex-rule":
      _updateCurrentTaskProfile((draft, context) => {
        const localRules = Array.isArray(draft.regex?.localRules)
          ? draft.regex.localRules
          : [];
        const nextRule = createLocalRegexRule(context.taskType, {
          script_name: `闂傚倸鍊风粈渚€骞栭锔藉亱婵犲﹤鐗嗙粈鍫熺箾閸℃鐛滈柤鏉挎健閹妫冨☉娆忔殘闂佸摜濮村Λ婵嬪蓟濞戙垹鍗抽柕濞垮劙缁ㄥ姊?${localRules.length + 1}`,
        });
        draft.regex = {
          ...(draft.regex || {}),
          localRules: [...localRules, nextRule],
        };
        return { selectRuleId: nextRule.id };
      });
      return;
    case "delete-regex-rule":
      _deleteRegexRule(actionEl.dataset.ruleId);
      return;
    case "add-global-regex-rule":
      _updateGlobalTaskRegex((draft) => {
        const localRules = Array.isArray(draft.localRules) ? draft.localRules : [];
        const nextRule = createLocalRegexRule("global", {
          script_name: `闂傚倸鍊搁崐椋庢閿熺姴纾婚柛娑卞弾濞尖晠鏌曟繛鐐珔闁哄绶氶弻鏇㈠醇濠靛洤顦╅梺鍝ュТ濡繈寮诲☉銏犲嵆闁靛鍎扮花濠氭⒑?${localRules.length + 1}`,
        });
        draft.localRules = [...localRules, nextRule];
        return { selectRuleId: nextRule.id };
      });
      return;
    case "delete-global-regex-rule":
      _deleteGlobalRegexRule(actionEl.dataset.ruleId);
      return;
    case "select-global-regex-rule":
      currentGlobalRegexRuleId = actionEl.dataset.ruleId || "";
      _refreshTaskProfileWorkspace();
      return;
    case "restore-global-regex-defaults": {
      const confirmed = window.confirm(
        "闂傚倷绀侀幖顐λ囬锕€鐤炬繝濠傜墛閸嬶繝鏌曢崼婵囧妞ゎ偅娲熼弻鐔封枔閸喗鐏嗛梺缁樺笒閿曨亪寮诲☉銏犵労闁告劦浜栭弸鏃堟⒑缁嬫鍎愰柟鍛婃倐閿濈偛鈹戦崶銊хФ闂侀潧顭梽鍕敇鐟欏嫮绡€婵炲牆鐏濋弸鐔虹磼缂佹ê濮夌€垫澘锕ョ粋鎺斺偓锝庝簻閻庮厼顪冮妶鍡欏缂侇喖绉瑰畷浼村幢濞戞瑧鍘遍梺鍝勬储閸斿本绂嶅鍫熺厽闊洦娲栭弸娑㈡煛瀹€鈧崰鏍€佸Ο渚叆闁告劦浜欓幃锝嗕繆閻愵亜鈧呯不閹存繍鍤曢柛鎾茶兌閻瑥顭跨捄琛″婵炲樊浜堕弫鍌炴煕閳╁喚娈樻い鎰偢濮婃椽鎳￠妶鍛咃繝姊婚崟顐ばх€规洘鍔曢埞鎴犫偓锝庝簻閸嬪秹姊洪棃娑氬婵炲眰鍔庢竟鏇㈡倷椤戝彞绨婚梺鍝勫暙濞层垽鍩€椤戣棄浜鹃梻浣侯焾椤戝棝骞戦崶褏鏆﹂柟鐑樺灍濡插牊绻涢崨顖氱殤缂佺姵鎹囧璇测槈濮楀棙鍍甸梺璇″瀻鐏炴儳鏋犻梻鍌欐祰椤骞愰幎鍓垮骞橀懜娈挎綗闂佸湱鍎ら〃蹇涘极閸ヮ剚鐓忓┑鐐戝啫鏆為柛?,
      );
      if (!confirmed) return;
      currentGlobalRegexRuleId = "";
      _patchGlobalTaskRegex(createDefaultGlobalTaskRegex(), { refresh: true });
      toastr.success("闂傚倸鍊搁崐椋庢閿熺姴纾婚柛娑卞弾濞尖晠鏌曟繛鐐珔闁哄绶氶弻鏇㈠醇濠靛洤顎涘┑鐐烘？閸楁娊寮婚妸銉㈡斀闁糕剝锚濞咃綁姊虹拠鑼闁哥姵鐗犻獮鍐ㄧ暋閹佃櫕鐎婚棅顐㈡处閹尖晜绂掓總鍛娾拺闁告捁灏欓崢娑㈡煕閵娿倕宓嗘い銏＄懆缁犳稑鈽夊Ο鑲╁幀濠电姰鍨煎▔娑⑺囬鐐插瀭婵犻潧娲ㄧ弧鈧梺闈涢獜缁插墽娑甸崜褏纾煎璺猴攻鐠愶繝鏌涢幒鎾虫诞妞ゃ垺绋戦…銊╁礋椤愵偀鍋?, "ST-BME");
      return;
    }
    default:
      return;
  }
}

function _renderTaskProfileWorkspace(state) {
  if (!state.profile) {
    return `
      <div class="bme-config-card">
        <div class="bme-config-card-title">濠电姷鏁搁崑娑㈩敋椤撶喐鍙忓Δ锝呭枤閺佸鎲告惔銊ョ疄闁靛ň鏅滈崑鍕⒒閸碍娅囬柣顓燁殜濮婃椽宕ㄦ繝鍐槱闂侀潻缍嗛崳锝呯暦椤栨稒鍎熼柍閿亾婵℃彃鐗撻弻鐔煎箚瑜忛敍宥団偓娑欑箞閹嘲顭ㄩ崨顓ф毉闂佺粯鎼换婵嬬嵁?/div>
        <div class="bme-config-help">闂備浇宕甸崰鎰垝鎼淬垺娅犳俊銈呮噹缁犱即鏌涘☉姗堟敾婵炲懐濞€閺岋絽螣閼姐們鍋為梺鍝勭焿缁犳捇寮诲澶婄厸濞达絽鎲″▓鑼磽娴ｅ搫校閻㈩垽绻濆璇测槈濡攱鐎诲┑鈽嗗灥濞咃絾绂掗婊呯＝濞撴埃鍋撶痪顓炴啞缁傚秴鈹戦崱鈺冨姺闂婎偄娲︾粙鎴犵不閿濆鐓熸俊顖濇閿涘秹鏌￠崱娆徯ｇ紒缁樼〒閳ь剛鏁搁…鍫ョ€锋俊鐐€栧▔锕傚礋椤掆偓瀵潡姊虹紒妯活棃婵炶壈宕靛Σ鎰版晲婢跺鍘遍梺鍝勬储閸斿苯鈻嶅鈧弻娑㈡偄閻戣棄寮伴梺鍝勫閸撴繈骞忛崨鏉戜紶闁告洖鐏氬В澶愭煟鎼淬値娼愰柟鎼侇棑濞嗐垹顫濋婵堢畾?/div>
      </div>
    `;
  }

  const taskMeta =
    state.taskTypeOptions.find((item) => item.id === state.taskType) ||
    state.taskTypeOptions[0];
  const profileUpdatedAt = _formatTaskProfileTime(state.profile.updatedAt);

  return `
    <div class="bme-task-shell">
      <div class="bme-task-action-bar">
        <div class="bme-task-nav-groups">
          <div class="bme-task-segmented-control">
            ${state.taskTypeOptions
              .map(
                (item) => `
                  <button
                    class="bme-task-type-btn ${item.id === state.taskType && !state.showGlobalRegex ? "active" : ""}"
                    data-task-action="switch-task-type"
                    data-task-type="${_escAttr(item.id)}"
                    type="button"
                  >${_escHtml(item.label)}</button>
                `,
              )
              .join("")}
          </div>
          <div class="bme-task-segmented-control bme-task-segmented-control--solo">
            <button
              class="bme-task-type-btn ${state.showGlobalRegex ? "active" : ""}"
              data-task-action="switch-global-regex"
              type="button"
            >
              闂傚倸鍊搁崐椋庢閿熺姴纾婚柛娑卞弾濞尖晠鏌曟繛鐐珔闁哄绶氶弻鏇㈠醇濠靛洤顎涘┑鐐烘？閸楁娊寮婚妸銉㈡斀闁糕剝锚濞咃綁姊?
            </button>
          </div>
        </div>
        <div class="bme-task-action-bar-right">
          <button class="bme-config-secondary-btn bme-bulk-profile-btn bme-task-btn-danger" data-task-action="restore-all-profiles" type="button" title="闂傚倸鍊峰ù鍥敋閺嶎厼鍌ㄧ憸鐗堝笒閸ㄥ倻鎲搁悧鍫濆惞闁搞儺鍓欓拑鐔兼煏婢跺牆鍔ゆい蟻鍥ㄢ拺闂傚牊鍗曢崼銉ョ柧婵炴垯鍨圭粈?6 濠电姷鏁搁崑鐐哄垂閸洖绠归柍鍝勫€婚々鍙夌箾閸℃ɑ灏紒鐘崇叀閺屾洝绠涚€ｎ亖鍋撻弴鐘电焼濠㈣埖鍔栭悡銉︾箾閹寸伝顏堫敂椤忓牊鐓熼柨婵嗘噹閼歌銇勯锝庢當闁宠棄顦埢搴∥熼悡搴⌒┑锛勫亼閸婃牠骞愰崜褍鍨濇い鏍仦閺咁剟鏌熼悧鍫熺凡缂佲偓鐎ｎ偁浜滈柡鍥╁仦閸ｅ綊鏌?>
            <i class="fa-solid fa-arrows-rotate"></i><span>闂傚倸鍊峰ù鍥敋閺嶎厼鍌ㄧ憸鐗堝笒閸ㄥ倻鎲搁悧鍫濆惞闁搞儺鍓欓拑鐔兼煏婢跺牆鍔ゆい蟻鍥ㄢ拺闂傚牊鍗曢崼銉ョ柧婵炴垯鍨圭粈?/span>
          </button>
          <button class="bme-config-secondary-btn bme-bulk-profile-btn" data-task-action="export-all-profiles" type="button" title="闂傚倷娴囬褍霉閻戣棄鏋侀柟闂寸閸屻劎鎲搁弬璺ㄦ殾闁汇垹澹婇弫鍥煏韫囨洖啸妞は佸洦鈷戦梻鍫熷崟閸儱鐤炬繛鎴欏灩缁€?6 濠电姷鏁搁崑鐐哄垂閸洖绠归柍鍝勫€婚々鍙夌箾閸℃ɑ灏紒鐘崇叀閺屾洝绠涚€ｎ亖鍋撻弴鐘电焼濠㈣埖鍔栭悡銉╂煟閺傛寧鎯堟い搴＄焸閺岋繝宕卞Ο鑽ゎ槹闂?>
            <i class="fa-solid fa-file-export"></i><span>闂傚倷娴囬褍霉閻戣棄鏋侀柟闂寸閸屻劎鎲搁弬璺ㄦ殾闁汇垹澹婇弫鍥煏韫囨洖啸妞は佸洦鈷戦梻鍫熷崟閸儱鐤炬繛鎴欏灩缁€?/span>
          </button>
          <button class="bme-config-secondary-btn bme-bulk-profile-btn" data-task-action="import-all-profiles" type="button" title="闂傚倷娴囬褍霉閻戣棄鏋侀柟闂寸閸屻劎鎲搁弬璺ㄦ殾闁挎繂顦獮銏＄箾閹寸儐鐒芥い蟻鍥ㄢ拺闂傚牊鍗曢崼銉ョ柧婵炴垯鍨圭粈澶愭煏婢跺牆鍓绘繛鎴欏灩缁狙囨煕椤垵娅樺ù鐓庡€搁—鍐Χ閸℃ǚ鎷瑰┑鐐跺皺閸犳牕顕ｉ銏╁悑濠㈣泛锕崬鍫曟⒑閹稿海绠撻悗娑掓櫊閹虫粏銇愰幒鎾嫼闂佺粯鍨熼弲婊冣枍閸℃稒鐓熸俊銈勭劍缁€鍫㈢磼鏉堚晛浠ч柍褜鍓ㄧ紞鍡涘窗閺嶎偆鐭嗛柛顐熸噰閸嬫捇鐛崹顔煎缂備胶绮敮鐐靛垝?>
            <i class="fa-solid fa-file-import"></i><span>闂傚倷娴囬褍霉閻戣棄鏋侀柟闂寸閸屻劎鎲搁弬璺ㄦ殾闁挎繂顦獮銏＄箾閹寸儐鐒芥い蟻鍥ㄢ拺闂傚牊鍗曢崼銉ョ柧婵炴垯鍨圭粈?/span>
          </button>
        </div>
      </div>

      ${state.showGlobalRegex
        ? _renderGlobalRegexPanel(state)
        : `
      <div class="bme-task-master-detail">
        <div class="bme-task-profile-editor">
          <div class="bme-task-editor-header">
            <div class="bme-task-editor-kicker">${_escHtml(taskMeta?.label || state.taskType)}</div>
            <div class="bme-task-editor-title-row">
              <label class="bme-visually-hidden" for="bme-task-profile-select">闂備浇宕甸崰鎰垝鎼淬垺娅犳俊銈呮噹缁犱即鏌涘☉姗堟敾婵炲懐濞€閺岋絽螣绾板崬濮曠紓浣瑰敾缂嶄線寮诲☉銏犲嵆闁靛鍎查悵顕€姊?/label>
              <select id="bme-task-profile-select" class="bme-config-input bme-task-editor-preset-select" title="闂傚倸鍊风粈渚€骞夐敍鍕殰闁圭儤鍤氬ú顏呮櫇闁逞屽墴閹箖鎮滈挊澶岀厬婵犮垼鍩栫粙鎾绘儗濡ゅ懏鈷戦柛娑橈攻婢跺嫰鏌涢敐搴℃珝鐎?>
                ${state.bucket.profiles
                  .map(
                    (profile) => `
                  <option
                    value="${_escAttr(profile.id)}"
                    ${profile.id === state.profile.id ? "selected" : ""}
                  >
                    ${_escHtml(profile.name)}${profile.builtin ? "闂傚倸鍊烽悞锔锯偓绗涘懐鐭欓柟杈鹃檮閸嬪鏌涢埄鍐槈闁肩缍婇幃妤呮濞戞瑦鍠愮紒鎯у⒔閸嬫捇濡甸崟顖氬嵆闁绘劖鎯屽Λ銈囩磽娴ｆ彃浜? : ""}
                  </option>
                `,
                  )
                  .join("")}
              </select>
              <div class="bme-task-profile-badges">
                <span class="bme-task-pill ${state.profile.builtin ? "is-builtin" : ""}">
                  ${state.profile.builtin ? "闂傚倸鍊风粈渚€骞夐敓鐘茬闁哄洢鍨圭粻鐘绘煙閹殿喖顣奸柛? : "闂傚倸鍊烽懗鍫曞储瑜旈妴鍐╂償閵忋埄娲稿┑鐘诧工閻楀﹪宕戦埡鍛厽闁逛即娼ф晶浼存煃?}
                </span>
                <span class="bme-task-pill">闂傚倸鍊风粈渚€骞栭鈷氭椽濡舵径瀣槐闂侀潧艌閺呮盯鎷戦悢灏佹斀闁绘ɑ褰冮弳鐔搞亜?${_escHtml(profileUpdatedAt)}</span>
              </div>
            </div>
            <div class="bme-task-editor-actions">
              <button class="bme-config-secondary-btn" data-task-action="save-profile" type="button"><i class="fa-solid fa-floppy-disk"></i><span>濠电姷鏁搁崕鎴犲緤閽樺娲晜閻愵剙搴婇梺绋跨灱閸嬬偤宕?/span></button>
              <button class="bme-config-secondary-btn" data-task-action="rename-profile" type="button"><i class="fa-solid fa-pen"></i><span>闂傚倸鍊搁崐鐑芥倿閿曚降浜归柛鎰典簽閻捇鏌熺紒銏犳灈缂佺姷濞€閺屻劑鎮㈤崫鍕戙垽鎮?/span></button>
              <button class="bme-config-secondary-btn" data-task-action="save-as-profile" type="button"><i class="fa-solid fa-copy"></i><span>闂傚倸鍊风粈渚€骞夐敓鐘冲仭閺夊牃鏅濇稉宥夋煙鏉堥箖妾柛瀣ㄥ€濋弻鏇熺節韫囨搩娲梺?/span></button>
              <button class="bme-config-secondary-btn" data-task-action="import-profile" type="button"><i class="fa-solid fa-file-import"></i><span>闂傚倷娴囬褍霉閻戣棄鏋侀柟闂寸閸屻劎鎲搁弬璺ㄦ殾?/span></button>
              <button class="bme-config-secondary-btn" data-task-action="export-profile" type="button"><i class="fa-solid fa-file-export"></i><span>闂傚倷娴囬褍霉閻戣棄鏋侀柟闂寸閸屻劎鎲搁弬璺ㄦ殾?/span></button>
              <button class="bme-config-secondary-btn bme-task-btn-danger" data-task-action="restore-default-profile" type="button"><i class="fa-solid fa-arrows-rotate"></i><span>闂傚倸鍊峰ù鍥敋閺嶎厼鍌ㄧ憸鐗堝笒閸ㄥ倻鎲搁悧鍫濆惞闁搞儺鍓欓惌妤€顭块懜鐬垶绂掑Ο琛℃斀闁宠棄妫楅悘鈩冦亜閹寸偟鎳囩€?/span></button>
            </div>
          </div>

          <div class="bme-task-subtabs">
            ${TASK_PROFILE_TABS.map(
              (tab) => `
                <button
                  class="bme-task-subtab-btn ${tab.id === state.taskTabId ? "active" : ""}"
                  data-task-action="switch-task-tab"
                  data-task-tab="${_escAttr(tab.id)}"
                  type="button"
                >
                  ${_escHtml(tab.label)}
                </button>
              `,
            ).join("")}
          </div>

          <div class="bme-task-tab-body">
            ${
              state.taskTabId === "generation"
                ? _renderTaskGenerationTab(state)
                : state.taskTabId === "debug"
                  ? _renderTaskDebugTab(state)
                  : _renderTaskPromptTab(state)
            }
          </div>
        </div>
      </div>
      `}
    </div>
  `;
}
function _renderTaskPromptTab(state) {
  return `
    <div class="bme-task-toolbar-row">
      <div class="bme-task-toolbar-inline">
        <button class="bme-config-secondary-btn" data-task-action="add-custom-block" type="button">
          + 闂傚倸鍊烽懗鍫曞储瑜旈妴鍐╂償閵忋埄娲稿┑鐘诧工閻楀﹪宕戦埡鍛厽闁逛即娼ф晶浼存煃缂佹ɑ绀€妞ゎ叀娉曢幑鍕偖鐎涙ɑ鏆伴梻?
        </button>
        <span class="bme-task-action-sep"></span>
        <select id="bme-task-builtin-select" class="bme-config-input bme-task-builtin-select">
          ${state.builtinBlockDefinitions
            .map(
              (item) => `
                <option value="${_escAttr(item.sourceKey)}">
                  ${_escHtml(item.name)}
                </option>
              `,
            )
            .join("")}
        </select>
        <button class="bme-config-secondary-btn" data-task-action="add-builtin-block" type="button">
          + 闂傚倸鍊风粈渚€骞夐敓鐘茬闁哄洢鍨圭粻鐘绘煙閹殿喖顣奸柛瀣典邯閺屾盯鍩勯崘顏佹闂?
        </button>
      </div>
      <span class="bme-task-block-count">${state.blocks.length} 濠电姷鏁搁崑鐐哄垂閸洖绠归柍鍝勫€婚々鍙夌節婵犲倸鏋ら柣?/span>
    </div>

    <div class="bme-task-block-rows">
      ${state.blocks.length
        ? state.blocks
            .map((block, index) => _renderTaskBlockRow(block, index, state))
            .join("")
        : `
            <div class="bme-task-empty">
              闂備浇宕甸崰鎰垝鎼淬垺娅犳俊銈呮噹缁犱即鏌涘☉姗堟敾婵炲懐濞€閺岋絽螣绾板崬濮曠紓浣瑰敾缂嶄線寮诲☉銏犲嵆闁靛鍎查悵顕€姊洪崫銉ユ瀻闂佸府绲介锝夊醇閺囩偟鍘搁梺绋款儏閻忔岸宕归崸妤€绠氶柍褜鍓熼弻娑樷槈濞嗘劗绋囬柣搴㈣壘椤︻垶鈥︾捄銊﹀磯闁绘艾鐡ㄩ弫楣冩⒑缁嬫鍎嶉柛搴ｆ暬瀵寮撮姀鐘茶€垮┑掳鍊愰崑鎾绘煃瑜滈崜姘舵偤閺囥垹桅闁圭増婢橀惌妤€顭跨捄铏圭劸婵炴潙瀚板娲濞戣鲸肖闂佺姘︽禍顒勫极椤曗偓婵＄兘鍩￠崒婊冨箰闂備胶顭堥張顒傜矙閹烘梹顐介柛娆忣槶娴滄粓鏌曢崼婵囧櫣闁哄棛鍋熺槐鎺斺偓锝庝憾濡偓闂佺硶鏂侀崑鎾愁渻閵堝棗绗傞柤鍐茬埣閸┿垽寮埀顒勫Φ閸曨喚鐤€闁规儳鐡ㄩ幃娆忊攽閻愯尙澧旈柛妤佸▕楠炲啫螖閸愨晛鏋傞梺鍛婃处閸橀箖宕ｅ┑鍫㈢＝濞达絽鎼暩闂佸摜濮甸悧鏇㈡偩妞嬪海鐭欓悹鍥╁亾濮婂綊骞忛崨鏉戜紶闁靛鍊楅悳濠氭⒒閸屾瑧顦﹂柟璇х節瀹曟繈寮撮姀鐘电枃闂佽澹嗘晶妤呭磻椤忓牊鐓曢柍鈺佸暟閳藉姊虹憗銈呪偓鏍ㄧ┍婵犲洦鍊烽柤纰卞墯閻т線姊?
            </div>
          `}
    </div>
  `;
}

function _renderTaskGenerationTab(state) {
  const inputGroups = TASK_PROFILE_INPUT_GROUPS[state.taskType] || [];
  return `
    <div class="bme-task-tab-body">
      ${TASK_PROFILE_GENERATION_GROUPS.map(
        (group) => `
          <div class="bme-config-card">
            <div class="bme-config-card-head">
              <div>
                <div class="bme-config-card-title">${_escHtml(group.title)}</div>
                <div class="bme-config-card-subtitle">
                  闂傚倸鍊峰鎺旀椤旀儳绶ゅΔ锝呭暞閸嬶紕鎲搁弮鍫濇槬闁绘劕鎼崘鈧銈嗗姧缁茶姤绂掗幒妤佲拺闂傚牊涓瑰☉娆愬濡炲閰ｉ埞蹇旂節閻㈤潧浠﹂柛銊ョ埣楠炴劙宕妷褏鐓嬮梺鍝勵槹閸╁牓宕崨瀛樷拺妞ゆ巻鍋撶紒澶婎嚟缁牓宕卞☉娆戝幐闂佸壊鍋侀崹娲汲閳哄懏鐓熼柣鏂挎啞瀹曞矂鏌＄仦鍓р槈闁宠閰ｉ獮鍥敆閸屾艾绗岀紓鍌氬€峰ù鍥ㄣ仈閸濄儲宕查柛顐犲劚缁犳牠鏌ら幁鎺戝姕缂傚秴娲﹂妵鍕敇閻愬樊娈紓浣藉煐閼归箖鎮鹃悜钘夋嵍妞ゆ挻绋戞禍楣冩煥濠靛棝顎楀ù婊勭矒閺?provider 濠电姵顔栭崰妤冩暜濡ゅ啰鐭欓柟鐑樸仜閳ь剨绠撳畷濂稿Ψ椤旇姤娅嶅┑鐘垫暩婵敻鎳濋崜褍顥氱憸鐗堝笚閻撶喖鏌熼悙顒€鈻曟い搴㈩殜閺岋紕鈧急鍐у闂傚倷娴囬褍顫濋敃鍌︾稏濠㈣埖鍔曟导鐘诲箹濞ｎ剙濡奸柣?
                </div>
              </div>
            </div>
            <div class="bme-task-field-grid">
              ${group.fields
                .map((field) =>
                  _renderGenerationField(
                    field,
                    state.profile.generation?.[field.key],
                    state,
                  ),
                )
                .join("")}
            </div>
          </div>
        `,
      ).join("")}
      ${inputGroups
        .map(
          (group) => `
            <div class="bme-config-card">
              <div class="bme-config-card-head">
                <div>
                  <div class="bme-config-card-title">${_escHtml(group.title)}</div>
                  <div class="bme-config-card-subtitle">
                    闂傚倷绀侀幖顐λ囬锕€鐤炬繝濠傜墛閸嬶繝鏌嶉崫鍕櫣闂傚偆鍨堕弻锝夊箣閿濆憛鎾绘煟閹绢垰浜鹃梺璇查缁犲秹宕曢崡鐏绘椽濡搁埡浣稿殤闂佺鏈銏ｃ亹閹烘挸浜规繛鎾村嚬閸ㄦ澘鈻撻鐔虹瘈婵炲牆鐏濋弸銈夋煕閻樺磭澧垫鐐诧工閳藉濮€閳哄倹娅嗛梻浣告啞濞诧箓宕㈡禒瀣辈闁哄啫鐗婇埛鎴炴叏閻熺増鎼愬┑鈥炽偢閹顫濋悡搴ｄ化濠电偛妫庨崹浠嬨€佸鈧慨鈧柣妯活問濡差垶姊绘笟鈧褔篓閳ь剟姊婚崟顐㈩伃鐎殿喗濞婇、鏃堝醇閻斿弶瀚介梻浣虹《閸撴繈銆冮崱娴板鍩勯崘锔跨盎濡炪倖鍔戦崺鍕熼埀顒勬倵鐟欏嫭绀冮柤褰掔畺閸┿垺鎯旈埦鈧弸搴ㄦ煙鐎电顎屾俊鎻掑槻閳规垿鎮欓弶鎴犱桓闂佸湱顭堥幗婊呭垝閺冣偓椤︾増鎯旈敐鍥х闂備浇娉曢崰鎾存叏閻㈢鐓曢柡鍥ュ灮閸欐捇鏌涢妷锝呭閻忓浚鍘鹃埀顒侇問閸犳牕顭囬敓鐘茬畺婵せ鍋撻柟顔界懇閸┾剝鎷呭畡閭︽闂傚倸鍊风粈浣革耿鏉堚晛鍨濇い鏍仜缁€澶愭煛閸ゅ爼顣﹀Ч妤呮⒑閹肩偛鍔橀柛鏂块叄閸┿垽寮惔鎾存杸闂佺粯顭堢划楣冨礂瀹€鍕厽闁绘柨鎲″畷宀勬煛瀹€瀣瘈鐎规洘甯掗～婵嬵敇閻愯弓鎲鹃梻?
                  </div>
                </div>
              </div>
              <div class="bme-task-field-grid">
                ${group.fields
                  .map((field) =>
                    _renderTaskInputField(
                      field,
                      state.profile.input?.[field.key],
                    ),
                  )
                  .join("")}
              </div>
            </div>
          `,
        )
        .join("")}
      <div class="bme-task-note">
        <strong>闂傚倷绀侀幖顐λ囬锕€鐤炬繝濠傜墕缁€澶嬫叏濡炶浜鹃梺闈涙缁舵岸鐛€ｎ喗鏅濋柍褜鍓涢悮鎯ь吋婢跺鍘靛銈嗙墱閸嬫稒绂嶆导瀛樼厱闁靛牆妫涘ú鎾煛?/strong> 闂?闂傚倷绀侀幖顐λ囬锕€鐤炬繝濠傜墛閸嬶繝鏌嶉崫鍕櫣闂傚偆鍨堕弻锝夊箣閿濆憛鎾绘煟閹绢垰浜鹃梺璇查缁犲秹宕曢崡鐏绘椽濡搁埡浣稿殤闂佺鐬奸崑鐐烘偂閻斿吋鐓忓┑鐐茬仢閸旀碍銇勮箛锝勭凹濞ｅ洤锕獮鎾诲箳閹炬潙鏋戦梻渚€鈧偛鑻晶浼存煙閾忣偅宕岀€殿喚鏁婚、妤呭礋椤愶綀绶㈤梻浣瑰缁诲倿藝娴兼潙纾?generation options闂傚倸鍊风欢姘焽瑜嶈灋婵°倕鎳庣壕褰掓煙闂傚鍔嶉柛瀣典邯閺屾盯寮撮妸銉т画闂佹娊鏀卞Λ鍐蓟濞戞ǚ妲堥柕蹇曞С閸犲﹪姊洪幖鐐测偓妤呭磻閻愬搫绠為柕濞炬櫆閸嬶繝鏌℃径濠勬皑闁稿鎸搁～銏沪鐠佽櫕鐫忛梻浣侯焾閻ジ宕戦悙鐑樺€块悹鍥梿瑜版帗鏅查柛銉ュ閸旂顪冮妶鍐ㄢ偓鏇㈠箠濮椻偓瀵濡搁妷銏☆潔濠碘槅鍨拃锕€鈻撻鐘电＝濞撴艾娲ら弸鐔虹磼鐎ｎ偄绗ч柍褜鍓涢弫鎼佸储瑜旈敐鐐测攽鐎ｅ灚鏅ｉ梺缁樏Ο濠偽涜箛娑欌拻濞达絼璀﹂弨鐗堛亜閺囩喓澧电€规洘婢樿灃闁告洦鍋呭▓鏌ユ⒒閸屾瑧鍔嶉柟顔肩埣瀹曟繂鐣濋崟鍨櫈闂佸壊鍋侀崕杈╃矆閸屾稒鍙忔俊鐐额嚙娴滈箖鎮楃憴鍕缂佽鍊块崺銉﹀緞婵炪垻鍠栧畷鐑筋敇閳垛晜鏁介梻鍌欑閹碱偊藝椤愶箑鐤炬繛鎴炩棨濞差亝鏅濋柛灞炬皑椤斿懘姊洪棃娑氬妞わ缚鍗冲鏌ヮ敆閸屾浜鹃柛蹇擃槸娴滈箖姊洪崨濠冨濞存粎鍋熷Σ鎰潩閼哥鎷虹紓浣割儓濞夋洜绮婚幍顔剧＜濠㈣泛锕︽禒娑樓庨崶褝韬€规洏鍔嶇换婵嬪礋閵婏妇浜欓梺璇查缁犲秹宕曢崡鐐嶆稑鈻庨幘铏緢濠电姴锕ら悧濠囨偂濞嗘挻鈷掗柍褜鍓熼獮鍥敍濮橆剙鑵愬┑鐘垫暩閸嬫盯鎮ф繝鍥у瀭鐟滅増甯掗悞鍨亜閹哄秷鍏岄柍顖涙礃閵囧嫰濡搁妷锔绘＆濡炪們鍨洪悷銉╂偩濠靛绀嬫い鎺嗗亾闁告搩鍣ｉ弻锝嗘償閵忊懇濮囬梺鎸庤壘椤法鎹勯搹鍓愩垽鏌嶉挊澶樻█妤犵偞锕㈤獮鍥ㄦ媴缁嬪灝顥嶉梺鑽ゅ枑缁秴顭垮鈧畷鎰版嚒閵堝棭娼?provider闂?
      </div>
    </div>
  `;
}

function _renderTaskRegexTab(state, options = {}) {
  const regex = options.regex || state.profile?.regex || {};
  const regexRules = Array.isArray(options.regexRules)
    ? options.regexRules
    : state.regexRules;
  const selectedRule =
    options.selectedRule === undefined ? state.selectedRule : options.selectedRule;
  const normalizedStages = normalizeTaskRegexStages(regex.stages || {});
  const deleteAction = options.deleteAction || "delete-regex-rule";
  const addAction = options.addAction || "add-regex-rule";
  const addButtonLabel = options.addButtonLabel || "+ 闂傚倸鍊风粈渚€骞栭锕€纾归柣鐔煎亰閻斿棙鎱ㄥ璇蹭壕閻犱警鍨堕弻娑㈠箛閸忓摜鍑归梺鍝ュТ濡繈寮诲☉銏犲嵆闁靛鍎扮花濠氭⒑?;
  const wrapperClassName = options.wrapperClassName
    ? ` ${options.wrapperClassName}`
    : "";
  const sectionTitle = options.sectionTitle || "濠电姷鏁告慨浼村垂閻撳簶鏋栨繛鎴炴皑閻捇鏌涢锝嗙闁哄绶氶弻鏇㈠醇濠靛浂妫ら梺宕囩帛濡啴鐛弽顬ュ酣顢楅埀顒佷繆娴犲鐓冮悹鍥ф▕濡插湱绱?;
  const sectionSubtitle =
    options.sectionSubtitle ||
    "濠电姷鏁搁崑娑㈩敋椤撶喐鍙忓Δ锝呭枤閺佸鎲告惔銊ョ疄闁靛ň鏅滈崑鍕⒒閸碍娅囬柣顓燁殜濮婃椽宕ㄦ繝鍐槱闂侀潻缍嗛崳锝呯暦椤栨稒鍎熼柕濠忓閸樺崬鈹戦悙鍙夘棡闁挎岸鏌ｈ箛鏇炐ｉ柕鍥у閺佸倿鎮剧仦钘夌哗闂備浇顕栭崰鏇犲垝濞嗘劒绻嗛柟闂寸閻撴稑霉閿濆懏鎲搁柣锝呭暱閳规垿鍩ラ崱妞惧缂備浇灏Λ鍕亱濠电偛妫欓幖鈺呭极閸℃绡€濠电姴鍊绘晶鏇犵磼閳ь剟宕卞Ο鑲╊啎闂佺硶鍓濋…鍥箠閸涱垳纾奸柍褜鍓氬鍕偓锝呯仛椤旀棃姊虹紒妯哄闁糕晜鐗滃☉鐢稿礈瑜庨崰鎰版煟濡も偓閻楀﹪藟閸懇鍋撶憴鍕缂佽鐗撻獮鍐煛閸涱喖娈ゅ銈嗗笒閸婃劙顢旈崼鐔叉嫼闂佸憡绋戦敃銉т焊椤撶姷纾煎璺侯儏閳绘洘顨ラ悙鏉戠伌濠殿喒鍋撻梺闈涚墕閹虫劙藝椤曗偓濮婂宕熼锝呮灎閻庤娲熷褔鈥﹂妸鈺佺闁诡垎鍕彋闂備礁鎼ˇ顖炴偋閸愵喖鐤炬繝濠傜墛閸嬧晠姊洪鈧粔鐢稿煕閹烘鐓曢柡鍥ュ妼娴滄粍銇勮箛濠冩珔闁宠鍨块、娆撳箚瑜岄幋鐑芥⒑閻熸澘绾ч柟绋垮暱閻ｇ兘鎮㈢喊杈ㄦ櫇闂侀潧娴氬鈧柟瀵稿厴濮?;
  const rulesTitle = options.rulesTitle || "闂傚倸鍊风粈渚€骞栭锔藉亱婵犲﹤鐗嗙粈鍫熺箾閸℃鐛滈柤鏉挎健閺岀喓绱掗姀鐘崇亶闂佹娊鏀卞Λ鍐蓟濞戙垹鍗抽柕濞垮劙缁ㄨ顪冮妶搴′壕缂傚秳绶氶獮鍐ㄧ暋閹佃櫕鐎婚棅顐㈡处閹尖晜绂掓總鍛娾拺?;
  const rulesSubtitle =
    options.rulesSubtitle ||
    "闂傚倸鍊风粈渚€骞栭锔藉亱婵犲﹤鐗嗙粈鍫熺箾閸℃鐛滈柤鏉挎健閹妫冨☉娆忔殘闂佸摜濮村Λ婵嬪蓟濞戙垹鍗抽柕濞垮劙缁ㄥ姊虹拠鑼闁哥姵鐗犲璇测槈濡攱鐎诲┑鈽嗗灠濠€閬嶆嚄閾忓湱纾介柛灞炬皑鏍″┑鈽嗗亜閸熸挳鐛崘鈺冾浄閻庯綆鈧厸鏅犻弻鏇㈠醇濠靛洨鈹涙繝銏ｎ潐閿曘垽骞冨畡閭︾叆闁告侗鍙庨弳顓㈡⒑閸︻収鐒鹃柟璇х節瀵煡宕奸弴鐔蜂汗閻庤娲栧ù鍌毭归崟顖涚厽闁绘ê寮舵径鍕喐閺夊灝鏆ｉ柨婵堝仱婵″爼宕ㄩ崒娑氭创鐎殿喖鐖煎畷褰掝敋閸涱剛纾藉┑锛勫亼閸婃牕顫忛悷鎳婃椽鎮㈤悡搴㈢€悗骞垮劚濞诧絽鈻介鍫熺厾婵炴潙顑嗗▍鍥煙閼奸娼愮紒缁樼洴瀵爼骞嬪┑鍥р偓顖滅磼閻愵剚绶茬紒澶婄秺楠炴劙宕ㄩ弶鎴狀槹濡炪倖鐗楁穱娲箺閺囥垺鈷戦柛锔诲幖娴滈箖鏌涢幘鏉戝摵鐎规洦鍨电粻娑㈠箻椤栨侗娼旈梻浣告贡閸嬫捇宕滃鑸靛亗濠靛倸鎲￠悡鏇熸叏濡も偓濡鐛Δ鍛叆婵炴垶锚閺嗭絿鈧娲栧畷顒勫煡婢跺á鐔搞偊鐠恒劊鍋炵紓鍌氬€搁崐鎼佸磹閹间礁绐楁慨妯挎硾缁愭鏌熼幑鎰靛殭闁?;
  const emptyText = options.emptyText || "闂備浇宕甸崰鎰垝鎼淬垺娅犳俊銈呮噹缁犱即鏌涘☉姗堟敾婵炲懐濞€閺岋絽螣绾板崬濮曠紓浣瑰敾缂嶄線寮诲☉銏犲嵆闁靛鍎查悵顕€姊洪崫銉ユ瀻闂佸府绲介锝夊醇閺囩偟鍘搁梺绋款儏閻忔岸宕归崸妤€绠氶柍褜鍓熼弻娑樷槈濞嗘劗绋囬柣搴㈣壘椤︻垶鈥︾捄銊﹀磯濞撴凹鍨伴崜閬嶆⒑閸︻厼鍘村ù婊冪埣瀵鈽夐姀鈩冩珕闂佽鍨庣仦鐐様濠碉紕鍋戦崐鏍暜濡ゅ啫鍨濋柟鎯х－閺嗭附鎱ㄥ鍡楀幋闁哄閰ｉ弻鐔兼倻濡偐鐣虹紓鍌氱Т閻楁挸顫忓ú顏勫窛濠电姴鍊婚悷鏌ユ⒑閼姐倕娅愮紓宥勭窔瀹曟椽鍩€?;
  const defaultNamePrefix = options.defaultNamePrefix || "闂傚倸鍊风粈渚€骞栭锔藉亱婵犲﹤鐗嗙粈鍫熺箾閸℃鐛滈柤鏉挎健閹妫冨☉娆忔殘闂佸摜濮村Λ婵嬪蓟濞戙垹鍗抽柕濞垮劙缁ㄥ姊?;
  const headerExtraActions = options.extraHeaderActions || "";
  const enableToggleTitle = options.enableToggleTitle || "闂傚倸鍊风粈渚€骞夐敓鐘茬鐟滅増甯掗崹鍌炴煙閹増顥夐柡瀣╃窔閺屾洟宕煎┑鍥舵￥濡炪倐鏅濋崗姗€骞冭ぐ鎺戠倞闁靛鍎崇粊宄邦渻閵堝骸浜栭柛濠冪墵楠炲牓濡搁妷銏℃杸闂佽宕樺▔娑㈠春瀹€鍕拺?;
  const enableToggleDesc =
    options.enableToggleDesc || "闂傚倸鍊烽懗鍫曗€﹂崼銏″床闁瑰鍋熺粻鎯р攽閻樿弓杩规繛鎴欏灩缁犵粯銇勯弮鍥ь棈鐞氭繈姊虹涵鍛棈闁规椿浜炲Σ鎰板即閻樼數鐓嬫繝闈涘€搁幉锟犳偂閺囥垺鐓欓柟顖嗗拑绱為柡浣哥墦濮婃椽宕ㄦ繛妤佺矒瀹曟劕螖閸愨晩娼熼梺鍝勫暙閻楁粓寮繝鍥ㄧ厾濠殿喗鍔曢埀顒侇殜楠炲銇愰幒鎾嫼闂侀潻瀵岄崢楣冨箠濡ゅ懏鐓曢柍閿亾闁哄懏绮撳顒勫焵椤掆偓閳规垿鎮欏顔兼婵犳鍣ｇ粻鏍€佸▎鎰瘈闁告洦鍘鹃ˇ顖炴倵楠炲灝鍔氭俊顐ｇ洴閵嗗懘鎮滈懞銉ヤ化闂佹悶鍎崝宀€寰婄紒妯镐簻妞ゆ劗濮撮埀顒侇殘濡叉劙骞掑Δ浣镐杭濠电偛妫楃换鎰邦敂閹绢喗鐓曢柡鍌氭惈娴滈箖姊婚崒娆戭槮闁硅绱曢弫顔嘉旈崨顔间画闂佹寧绻傞ˇ顖炴倿?;
  const editorState = {
    ...state,
    selectedRule,
  };

  return `
    <div class="bme-task-tab-body${wrapperClassName}">
      <div class="bme-regex-settings-stack">
        <div class="bme-config-card bme-regex-settings-card">
          <div class="bme-config-card-head">
            <div>
              <div class="bme-config-card-title">${_escHtml(sectionTitle)}</div>
              <div class="bme-config-card-subtitle">
                ${_escHtml(sectionSubtitle)}
              </div>
            </div>
            <div class="bme-task-inline-actions">
              <button class="bme-config-secondary-btn" data-task-action="inspect-tavern-regex" type="button">
                闂傚倸鍊风粈渚€骞栭銈嗗仏妞ゆ劧绠戠壕鍧楁煕閹邦垼鍤嬮柤鏉挎健閺屾稑鈽夊鍐姺婵炲瓨绮岀紞濠囧蓟閻旂厧绠氱憸宥夊汲鏉堛劊浜滈柕鍫濇噺閸ｈ銇勯鈩冪《闁圭懓瀚伴幖褰掑礈閹扳晛鈧繈寮婚埄鍐╁闂傚牊绋堥崑鎾澄旈崨顓犵枀闂佸湱铏庨崰鏍矆鐎ｎ偁浜滈柟鎵虫櫅閻忣喖霉?
              </button>
              ${headerExtraActions}
            </div>
          </div>

          <div class="bme-task-toggle-list">
            <label class="bme-toggle-item">
              <span class="bme-toggle-copy">
                <span class="bme-toggle-title">${_escHtml(enableToggleTitle)}</span>
                <span class="bme-toggle-desc">${_escHtml(enableToggleDesc)}</span>
              </span>
              <input
                type="checkbox"
                data-regex-field="enabled"
                ${regex.enabled ? "checked" : ""}
              />
            </label>

            <label class="bme-toggle-item">
              <span class="bme-toggle-copy">
                <span class="bme-toggle-title">濠电姷鏁告慨浼村垂閻撳簶鏋栨繛鎴炴皑閻捇鏌涢锝嗙闁哄绶氶弻鏇㈠醇濠垫劖效闂佺粯鎸撮崑鎾绘⒒娴ｅ憡璐￠柛搴涘€濋妴鍐疀閹句焦妞介、妤佹媴閻熸澘浼庢繝鐢靛Т閻忔岸骞愭ィ鍐ㄧ濞寸厧鐡ㄩ悡?/span>
                <span class="bme-toggle-desc">闂傚倷娴囧畷鍨叏閺夋嚚娲煛閸滀焦鏅悷婊勫灴婵?global / preset / character 婵犵數濮甸鏍窗濡ゅ啯宕查柟閭﹀枛缁躲倕霉閻樺樊鍎忛柛銊ュ€归妵鍕冀椤愵澀绮剁紓浣哄珡閸ャ劎鍘繝銏ｅ煐缁嬫垿銆呴鍕厽闁哄稁鍘洪幉楣冩煛?/span>
              </span>
              <input
                type="checkbox"
                data-regex-field="inheritStRegex"
                ${regex.inheritStRegex !== false ? "checked" : ""}
              />
            </label>
          </div>
        </div>

        <div class="bme-config-card bme-regex-settings-card">
          <div class="bme-task-section-label">濠电姷鏁告慨浼村垂閻撳簶鏋栨繛鎴炴皑閻捇鏌涢锝嗙闁哄绶氶弻鏇㈠醇濠垫劖笑缂備胶瀚忛崶銊у帾婵犮垼鍩栫粙鎴︺€呴鍕厽?/div>
          <div class="bme-task-toggle-list">
            ${[
              ["global", "闂傚倸鍊烽懗鍫曗€﹂崼銏″床闁割偁鍎辩粈澶屸偓鍏夊亾闁告洦鍓欓崜?],
              ["preset", "闂備浇宕甸崰鎰垝鎼淬垺娅犳俊銈呮噹缁犱即鏌涘☉姗堟敾婵炲懐濞€閺岋絽螣绾板崬濮曠紓浣瑰敾缂嶄線寮诲☉銏犲嵆闁靛鍎查悵顕€姊?],
              ["character", "闂傚倷娴囧畷鐢稿窗閹扮増鍋￠柨鏃傚亾閺嗘粓鏌ｉ弬鎸庢喐闁绘繆娉涢埞鎴︽偐閸欏鎮欑紒缁㈠幐閸?],
            ]
              .map(
                ([key, label]) => `
                  <label class="bme-toggle-item">
                    <span class="bme-toggle-copy">
                      <span class="bme-toggle-title">${label}</span>
                      <span class="bme-toggle-desc">闂傚倸鍊风粈渚€骞夐敓鐘茬鐟滅増甯掗崹鍌炴煙閹増顥夐柡?${label} 闂傚倸鍊风粈渚€骞栭位鍥敇閵忕姷锛熼梺鑲┾拡閸撴繃鎱ㄩ搹顐犱簻闁哄洦顨呮禍楣冩⒑?Tavern 婵犵數濮甸鏍窗濡ゅ啯宕查柟閭﹀枛缁躲倕霉閻樺樊鍎忛柛銊ュ€归妵鍕冀椤愵澀绮堕弶?/span>
                    </span>
                    <input
                      type="checkbox"
                      data-regex-source="${key}"
                      ${(regex.sources?.[key] ?? true) ? "checked" : ""}
                    />
                  </label>
                `,
              )
              .join("")}
          </div>
        </div>

        <div class="bme-config-card bme-regex-settings-card">
          <div class="bme-task-section-label">闂傚倸鍊风粈浣革耿闁秵鍋￠柟鎯版楠炪垽鏌嶉崫鍕偓褰掑级閹间焦鈷掗柛灞捐壘閳ь剚鎮傚畷顖炲箮閽樺妲梺鍝勭▉閸欏酣寮?/div>
          <div class="bme-task-toggle-list">
            ${TASK_PROFILE_REGEX_STAGES.map(
              (stage) => `
                <label class="bme-toggle-item">
                  <span class="bme-toggle-copy">
                    <span class="bme-toggle-title">${_escHtml(stage.label)}</span>
                    <span class="bme-toggle-desc">${_escHtml(stage.desc)}</span>
                  </span>
                  <input
                    type="checkbox"
                    data-regex-stage="${_escAttr(stage.key)}"
                    ${isTaskRegexStageEnabled(normalizedStages, stage.key) ? "checked" : ""}
                  />
                </label>
              `,
            ).join("")}
          </div>
        </div>
      </div>

      <div class="bme-config-card bme-regex-rule-card">
        <div class="bme-config-card-head">
          <div>
            <div class="bme-config-card-title">${_escHtml(rulesTitle)}</div>
            <div class="bme-config-card-subtitle">
              ${_escHtml(rulesSubtitle)}
            </div>
          </div>
          <button class="bme-config-secondary-btn" data-task-action="${_escAttr(addAction)}" type="button">
            ${_escHtml(addButtonLabel)}
          </button>
        </div>

        <div class="bme-regex-rule-rows">
          ${regexRules.length
            ? regexRules
                .map((rule, index) =>
                  _renderRegexRuleRow(rule, index, editorState, {
                    deleteAction,
                    defaultNamePrefix,
                  })
                )
                .join("")
            : `
                <div class="bme-task-empty">
                  ${_escHtml(emptyText)}
                </div>
              `}
        </div>
      </div>
    </div>
  `;
}

function _renderGlobalRegexPanel(state) {
  return _renderTaskRegexTab(
    {
      ...state,
      selectedRule: state.selectedGlobalRegexRule,
    },
    {
      regex: state.globalTaskRegex,
      regexRules: state.globalRegexRules,
      selectedRule: state.selectedGlobalRegexRule,
      addAction: "add-global-regex-rule",
      selectAction: "select-global-regex-rule",
      deleteAction: "delete-global-regex-rule",
      addButtonLabel: "+ 闂傚倸鍊风粈渚€骞栭锕€纾归柣鐔煎亰閻斿棙鎱ㄥ璇蹭壕閻犱警鍨堕弻娑㈠箛闂堟稒鐏嶉梺缁樺笧缁垶骞堥妸銉庣喖宕稿Δ鈧幗鐢告⒑閸濆嫭顥滅紒缁橈耿楠炲啫鐣￠幍铏€婚棅顐㈡处閹尖晜绂掓總鍛娾拺?,
      wrapperClassName: "bme-global-regex-panel",
      sectionTitle: "闂傚倸鍊搁崐椋庢閿熺姴纾婚柛娑卞弾濞尖晠鏌曟繛鐐珔闁哄绶氶弻鏇㈠醇濠靛洤顎涘┑鐐烘？閸楁娊寮婚妸銉㈡斀闁糕剝锚濞咃綁姊虹拠鑼闁哥姵鐗犻獮鍐喆閸曨剙顎撶紓浣割儏缁ㄩ亶骞愰崘顔解拺?,
      sectionSubtitle: "闂傚倸鍊风粈浣革耿闁秲鈧倹绂掔€ｎ亞锛涢梺鐟板⒔缁垶鎮″☉銏＄厱妞ゆ劧绲跨粻銉︿繆閼碱剙鍘撮柡宀€鍠栭悰顕€宕归鍙ョ礄闁诲氦顫夊ú妯兼崲閸儱鍨傚Δ锝呭暙缁€鍐煙缂佹ê绗х紒瀣搐閳规垿鎮欓懠顒佹喖缂備緡鍠氭繛鈧€规洘鍨垮畷鐔碱敍濮樿京鏆梻浣筋潐閸庢娊顢氶銏犵厺闁哄啫鐗婇悡鍐喐濠婂牆绀堟慨妯夸含缁憋箓鏌﹀Ο渚▓婵炴挸顭烽弻锝夊箛闂堟稑顫╅柟鍏兼綑閿曨亜顫忓ú顏勫窛濠电姴鍟伴崢鎼佹⒑閸涘﹥灏扮紒璇茬墦閵嗕礁螖閳ь剟鈥﹂妸鈺侀唶婵犻潧鐗滃Σ瀛樼節閻㈤潧浠滄俊顐ｎ殘閹广垽骞掗弬娆炬婵犵數濮电喊宥夋偂閺囥垻鍙撻柛銉ｅ妽缁€鈧繛瀵稿У濡炰粙寮诲鍫闂佺绻戠粙鎾跺垝閸喓鐟归柍褜鍓濆Λ鐔兼⒑閸濆嫯顫﹂柛搴㈢叀瀹曟垿濡搁埡鍌滃帾婵犵數濮寸换妯侯瀶椤曗偓濮婂宕熼銇帮絿绱掔紒妯肩畾妞わ附濞婇弻娑㈠籍閳ь剟宕归崸妤€鏄ラ柍褜鍓氶妵鍕箣閿濆棛銆婇梺鍛婃煥缁夋挳鈥﹂懗顖ｆЬ闂佸搫鎷嬮崑濠囩嵁閸愵喖绾ч悹鎭掑妽濞堟洟姊洪崨濠冨闁稿繑锕㈠鎼佸幢濡炵粯鏂€闂佺粯鍔樼亸娆愭櫠閺囥垺鐓曟慨姗堢到娴滃墽绱撻崒娆戝妽妞ゃ劌鎳橀幆宀勫磼濮樺吋缍庢繛瀵稿Т椤戝懐绮堢€ｎ偁浜滈柟鎵虫櫅閻掔儤绻涙總闀愭喚闁哄矉缍侀幃銏ゅ传閵夛箑娅戦梺璇插閸戝綊宕滈悢椋庢殾鐟滅増甯╅弫宥夋煟閹邦剙妫?,
      enableToggleTitle: "闂傚倸鍊风粈渚€骞夐敓鐘茬鐟滅増甯掗崹鍌炴煙閹増顥夐柡瀣╃窔閺屾洟宕煎┑鎰ч梺缁樺笧缁垶骞堥妸銉庣喖宕稿Δ鈧幗鐢告⒑閸濆嫭顥滅紒缁樺灴楠炲牓濡搁妷銏℃杸闂佽宕樺▔娑㈠春瀹€鍕拺?,
      enableToggleDesc: "闂傚倸鍊烽懗鍫曗€﹂崼銏″床闁瑰鍋熺粻鎯р攽閻樿弓杩规繛鎴欏灩缁犵粯銇勯弮鍥ь棈鐞氭繈姊洪悷鏉挎倯闁伙綆浜畷纭呫亹閹哄鍋撻崒鐐茶摕闁靛濡囬崢鎼佹⒑閸撴彃浜濈紒璇茬Т鍗遍柣鎴ｅГ閻撴瑦顨ラ悙鑼虎闁诲繗灏欓埀顒冾潐濞叉鎹㈤崼銉ユ瀬闁瑰墽绮崑鎰版煙缂佹ê绗掔紒鐙呯到閳规垿鎮欓弶鎴犱桓闂佸湱顭堥幗婊呭垝閺冨牆鍨傛い鎰剁稻閻濈兘姊烘导娆戝埌闁哄牜鍓熷畷鎴濐潨閳ь剟骞冨鈧幃娆撳箵閹烘挸鈧垶鎮楃憴鍕鐟滄澘鍟村﹢渚€姊洪幐搴ｇ畵婵☆偅鐟х划鍫ュ焵椤掑嫭鈷戦柛娑橈功閹插潡鏌涢幘瀵哥畼缂侇喖顑呴鍏煎緞濡粯娅囬梻浣瑰缁诲倹顨ラ崨濠佺箚鐟滄柨顫忓ú顏勫窛濠电姴鍊婚悷鏌ユ⒑閼姐倕鏆遍柡鍛Т閻ｇ兘濮€閵堝憘褔鏌涢妷銏℃珖闁挎稓鍋涢—鍐Χ閸℃﹩姊块梺闈涙閸嬫捇姊?,
      rulesTitle: "闂傚倸鍊搁崐椋庢閿熺姴纾婚柛娑卞弾濞尖晠鏌曟繛鐐珔闁哄绶氶弻鏇㈠醇濠垫劖效闂佹娊鏀卞Λ鍐蓟濞戙垹鍗抽柕濞垮劙缁ㄨ顪冮妶搴′壕缂傚秳绶氶獮鍐ㄧ暋閹佃櫕鐎婚棅顐㈡处閹尖晜绂掓總鍛娾拺?,
      rulesSubtitle: "闂傚倷绀侀幖顐λ囬锕€鐤炬繝濠傜墛閸嬶繝鏌嶉崫鍕櫣闂傚偆鍨伴—鍐偓锝庝簼閹癸絿鐥幆褋鍋㈤柟顔筋殔閳藉鈻嶉褌娴锋い锝勭矙濮婄粯鎷呴崨濠呯濡炪倧绲肩划娆忕暦閹达箑绠荤紓浣诡焽閸樻悂姊洪崜鎻掍簼缂佽绉村嵄闁绘垼濮ら悡娆愵殽閻愯尙浠㈤柣蹇氬皺閳ь剝顫夊ú妯兼崲閸儱鍨傚Δ锝呭暙缁€鍐煙缂佹ê绗х紒瀣搐閳规垿鎮欓懠顒佹喖缂備緡鍠氭繛鈧€规洘鍨垮畷鍗烆渻缂佹浜栭梻浣侯攰閹活亪姊介崟顖氱厱闁哄啫鐗婇悡鏇㈡煛閸ャ儱濡煎ù婊勭矋閵囧嫰顢曢鍌溞滈梺璇″枛閸㈡煡鍩㈡惔銈囩杸闁瑰灝鍟╅幃锝夋⒒娴ｇ顥忛柣鎾崇墦瀹曞綊鎳滈崗鍝ョ畾?,
      emptyText: "闂備浇宕甸崰鎰垝鎼淬垺娅犳俊銈呮噹缁犱即鏌涘☉姗堟敾婵炲懐濞€閺岋絽螣閹稿海褰ф繛瀛樺殠閸婃牗绌辨繝鍥舵晬婵犻潧妫楅幆鐐测攽椤旂》韬紒鐘崇墵瀵鏁撻悩鏌ュ敹濠电姴鐏氶崝鏍煝閸儲鈷戦梺顐ゅ仜閼活垱鏅堕娑欏弿婵☆垳顭堟慨鍌溾偓娈垮櫘閸嬪﹥淇婇崼鏇炴そ濞达綀顫夐妴鍐⒒娴ｇ懓顕滅紒璇插€块獮濠冩償閵婏箑鈧爼鏌ｉ弬鍨倯闁稿鍓濈换娑㈠幢濡ゅ啰顔囧銈呯箚閺呯娀寮诲☉鈶┾偓锕傚箣濠靛牅妗撳┑?,
      defaultNamePrefix: "闂傚倸鍊搁崐椋庢閿熺姴纾婚柛娑卞弾濞尖晠鏌曟繛鐐珔闁哄绶氶弻鏇㈠醇濠靛洤顦╅梺鍝ュТ濡繈寮诲☉銏犲嵆闁靛鍎扮花濠氭⒑?,
      extraHeaderActions: `
        <button class="bme-config-secondary-btn bme-task-btn-danger" data-task-action="restore-global-regex-defaults" type="button">
          闂傚倸鍊峰ù鍥敋閺嶎厼鍌ㄧ憸鐗堝笒閸ㄥ倻鎲搁悧鍫濆惞闁搞儺鍓欓惌妤€顭块懜鐬垶绂掑Ο琛℃斀闁宠棄妫楅悘鈩冦亜閹寸偟鎳囩€?
        </button>
      `,
    },
  );
}
function _formatRegexReuseSourceState(source = {}) {
  const states = [];
  states.push(source.enabled ? "闂備浇顕уù鐑藉箠閹捐绠熼梽鍥Φ閹版澘绀冩い鏃囧亹閻ｉ箖鏌熼崗鑲╂殬闁告柨绉瑰畷? : "闂備浇顕уù鐑藉箠閹捐绠熼梽鍥Φ閹版澘绀冩い鏃囧亹閻撴垿鎮峰鍕叆妞?);
  states.push(source.allowed === false ? "闂傚倸鍊风粈渚€骞栭锔藉亱婵犲﹤瀚々鏌ユ煥濠靛棭妲虹€规挷绶氶悡顐﹀炊閵娧€濮囬梺缁樻尨閸嬫捇姊绘担鍛婅础闁稿簺鍊濋妴鍐疀閹句焦妞介、妤呭礋椤掑倸骞堥梻濠庡亜濞层倗鈧稈鏅濈划濠囨偋閸稐绨? : "闂傚倸鍊烽懗鍫曗€﹂崼銏″床閻庯綆鈧垹缍婂畷鍫曨敆婢跺娅撻梻濠庡亜濞诧妇绮欓幋锔藉剹婵°倕鎳忛悡鏇㈡倶閻愭彃鈷旈柟鍐叉嚇閺?);
  states.push(
    source.resolvedVia === "bridge"
      ? "闂傚倸鍊搁崐椋庢閿熺姴纾婚柛娑卞枤閳瑰秹鏌ц箛姘兼綈鐎规洘鐓￠弻娑㈠箛閻㈤潧甯ュ┑鐐茬摠閻楃娀寮婚弴鐔风窞婵炴垶姘ㄩ弳鐘崇節閵忥絾纭剧紒澶婄秺楠炲啳銇愰幒鎴犲€炲銈呯箰缁夋潙鈻撻銏″仭?
      : source.resolvedVia === "fallback"
        ? "闂傚倸鍊搁崐椋庢閿熺姴纾婚柛娑卞枤閳瑰秹鏌ц箛姘兼綈鐎?fallback 闂傚倷娴囧畷鍨叏閺夋嚚娲煛閸滀焦鏅悷婊勫灴婵?
        : "闂傚倸鍊风粈渚€骞栭位鍥敇閵忕姷锛熼梺鑲┾拡閸撴繃鎱ㄩ搹顐犱簻闁哄洦顨呮禍楣冩倵濞堝灝鏋ら柡浣割煼閵嗕線寮崼婵嗚€垮┑鐐叉缁绘劗绱?,
  );
  return states.join(" 闂?");
}

function _formatRegexReuseSourceLabel(sourceType = "") {
  if (sourceType === "global") return "闂傚倸鍊烽懗鍫曗€﹂崼銏″床闁割偁鍎辩粈澶屸偓鍏夊亾闁告洦鍓欓崜?;
  if (sourceType === "preset") return "濠电姷顣藉Σ鍛村磻閸涱収鐔嗘俊顖氱毞閸嬫挸顫濋悡搴ｄ桓濡?;
  if (sourceType === "character") return "闂傚倷娴囧畷鐢稿窗閹扮増鍋￠柨鏃傚亾閺嗘粓鏌ｉ弬鎸庢喐闁绘繆娉涢埞鎴︽偐閸欏鎮欑紒缁㈠幐閸?;
  if (sourceType === "local") return "濠电姷鏁搁崑娑㈩敋椤撶喐鍙忓Δ锝呭枤閺佸鎲告惔銊ョ疄闁靛ň鏅滈崑鍕煟閹炬娊顎楅柣婵嚸—鍐Χ閸℃娼戦梺绋款儐閹歌崵鎹㈠┑瀣劦?;
  return sourceType ? String(sourceType) : "闂傚倸鍊风粈渚€骞栭锔藉亱婵犲﹤瀚々鏌ユ煟閹邦喖鍔嬮柛?;
}

function _formatRegexReuseReplaceText(rule = {}) {
  if (rule.promptStageMode === "display-only") {
    return "闂傚倸鍊烽悞锔锯偓绗涘懐鐭欓柟杈鹃檮閸嬪鏌涘☉鍗炵仩闁搞劍绻堥獮鏍庨鈧俊濂告煕濞嗗骏韬柡灞剧洴楠炴ê顪冮悙顒夋▊缂備緡鍠氶弫鍝ユ閹惧鐟归柛銉戝倻鍑规繝纰樷偓鍐茬骇閻㈩垽绻濋弫鎰版倷閺夋垹绐為梺褰掑亰閸撴盯藝椤愨懇鏀介柣鎰级椤ョ偤鏌ｉ悢婵嗘噽閻棗顭跨捄鍙峰牆危閸儲鐓欓柟顖嗗拑绱為柛鐔锋憸缁辨挻鎷呴搹鐟扮闂佹寧娲忛崹褰掓偩?Memory LLM 闂傚倷娴囧畷鍨叏閺夋嚚娲敇閵忕姷鍝楅梻渚囧墮缁夌敻宕曢幋婢濆綊鎮℃惔锝嗘喖闂?;
  }
  if (rule.promptStageMode === "fallback-skip-beautify") {
    return "闂傚倸鍊烽悞锔锯偓绗涘懐鐭欓柟杈鹃檮閸嬪鐓崶銊︾妞ゆ劒绮欓弻鏇熺箾閻愵剚鐝旂紓浣插亾鐎光偓閸曨剛鍘搁悗瑙勬惄閸犳牠骞婃径鎰；闁瑰墽绮崐濠氭煢濡警妲哥€规挸妫濆娲捶椤撗呭姼婵°倗濮撮幉锟犲箚閺冣偓缁绘繈宕堕妸褍寮虫繝鐢靛仦閸ㄥ爼鈥﹂崶顒€姹查柣婊勭瑩lback 婵犵數濮烽。钘壩ｉ崨鏉戝瀭妞ゅ繐鐗嗛悞鍨亜閹哄棗浜剧紒鍓ц檸閸樻儳鈽夐悽绋跨劦妞ゆ帊鑳剁粻楣冩煙鐎电浠﹂悘蹇ｅ幗閵囧嫰骞嬪┑鍡╀紑缂備緡鍣崢钘夘嚗閸曨厸鍋撻敐搴濇喚闁搞們鍊曢埞鎴︻敊閻偒浜炴竟鏇㈩敇閻樺吀绗夋繝鐢靛У绾板秹鎮?Prompt闂?;
  }
  if (typeof rule.effectivePromptReplaceString === "string" && rule.effectivePromptReplaceString.length > 0) {
    return rule.effectivePromptReplaceString;
  }
  if (typeof rule.replaceString === "string" && rule.replaceString.length > 0) {
    return rule.replaceString;
  }
  return "闂傚倸鍊烽悞锔锯偓绗涘懐鐭欓柟杈鹃檮閸嬪鐓崶銊р槈闁?- 闂傚倸鍊风粈渚€骞夐敍鍕殰闁绘劕顕粻楣冩煃瑜滈崜姘辨崲濞戙垹宸濇い鎾卞灩瀵即鎮楃憴鍕濠殿噣绠栨俊鐢稿箛閺夎法顔婇梺鐟扮摠缁诲棛绮婇幘顔解拻濞达絽鎲￠崯鐐烘煕閺冣偓濞茬喖鐛繝鍐╁劅妞ゎ厽鍨堕弲鈺呮⒑鐟欏嫬顥嬪褎顨婂?;
}

function _renderRegexReuseBadges(rule = {}) {
  const badges = [];
  if (rule.promptStageMode === "display-only") {
    badges.push({
      className: "is-clear",
      text: "濠电姷鏁搁崑娑㈩敋椤撶喐鍙忛柟缁㈠枛缁犵娀鐓崶銊﹀闁绘梻顭堢欢鐐碘偓鍏夊亾闁逞屽墴閹?,
    });
  } else if (rule.promptStageMode === "host-real") {
    badges.push({
      className: "is-transform",
      text: "闂傚倷娴囬褍霉閻戣棄绠犻柟鎹愵嚙妗呭┑鈽嗗灠閻ㄧ兘宕戦幘缁橆棃婵炴垶姘ㄩ崝顖炴⒑鐠団€崇仩婵炲樊鍙冮獮鍐閳藉棙效闁瑰吋鐣崹铏规娴煎瓨鈷掑ù锝呮啞鐠愶繝鏌ｉ悢绋库枙鐎规洟浜堕崺锟犲磼濞戞瑦绶?,
    });
  } else if (rule.promptStageMode === "host-fallback") {
    badges.push({
      className: "is-prompt",
      text: "闂傚倸鍊风粈浣革耿鏉堚晛鍨濇い鏍ㄧ矋閺嗘粌鈹戦悩鎻掆偓鐢稿几鎼淬劍鐓忛煫鍥ь儏閳ь剚娲滅划鍫ュ磼閻愬鍘介梺瑙勫劤閸熷潡鎯侀妸鈺傜厱闁绘棃鏀遍崰姗€鏌″畝鈧崰鎾跺垝椤撶偐妲堟俊顖欑串缁辩偤姊虹悰鈥充壕?,
    });
  } else if (rule.promptStageMode === "fallback-skip-beautify") {
    badges.push({
      className: "is-skip",
      text: "fallback 闂傚倷娴囧畷鍨叏閹绢喖绠规い鎰堕檮閸嬵亪鏌涢妷銏℃珕鐎规洘鐓￠弻娑㈠箛閸忓摜鏁栫紓浣插亾闁告劦鍠栫粻鍦磼椤旂厧甯ㄩ柛瀣崌楠炲洦鎷呴崨濠庡敳",
    });
  } else if (rule.promptStageMode === "replace") {
    badges.push({
      className: "is-transform",
      text: "闂傚倸鍊风粈渚€骞栭锔藉亱婵犲﹤鐗嗙粈鍫熺箾閸℃鐛滈柤鏉挎健閺岀喓绱掗姀鐘崇亪闁诲孩鑹鹃ˇ鐢稿蓟瀹ュ牜妾ㄩ梺鍛婃尰缁嬫挸危閹版澘绠虫俊銈傚亾闂佸崬娲弻锝夊即濮橀硸妲繝纰樺閸ャ劉鎷?,
    });
  } else {
    badges.push({
      className: "is-skip",
      text: "闂備浇宕甸崰鎰垝鎼淬垺娅犳俊銈呮噹缁犱即鏌涘☉姗堟敾婵炲懐濞€閺岋絽螣閾忕櫢绱為梺宕囩帛濮婂鍩€椤掆偓缁犲秹宕曢崡鐐嶆稑螖閸涱厾鍘遍梺鍝勫暙閻楀﹪宕?,
    });
  }
  if (rule.markdownOnly) {
    badges.push({
      className: "is-skip",
      text: "闂傚倷娴囧畷鍨叏閹绢喖绠规い鎰堕檮閸嬵亪鏌涢妷銏℃珕鐎?MD)",
    });
  }
  if (rule.promptOnly) {
    badges.push({
      className: "is-prompt",
      text: "濠?Prompt",
    });
  }
  if (
    rule.sourceType === "local" &&
    rule.promptStageMode !== "skip" &&
    rule.promptStageApplies === false
  ) {
    badges.push({
      className: "is-skip",
      text: "闂備浇宕甸崰鎰垝鎼淬垺娅犳俊銈呮噹缁犱即鏌涘☉姗堟敾婵炲懐濞€閺岋絽螣閾忕櫢绱炲銈傛櫇閸忔﹢骞冭ぐ鎺戠倞闁靛鍎崇粊宄邦渻閵堝骸浜栭柛濠冪箞瀵鏁撻悩鏌ュ敹濡炪倖鍔х槐鏇㈡儎鎼淬劍鈷戦悹鍥ｂ偓宕囦哗闂備礁搴滅紞渚€鐛?,
    });
  }
  return badges
    .map(
      (badge) => `<span class="bme-regex-preview-item__badge ${badge.className}">${_escHtml(badge.text)}</span>`,
    )
    .join("");
}

function _renderRegexReuseRuleList(rules = [], emptyText = "闂?, options = {}) {
  if (!Array.isArray(rules) || rules.length === 0) {
    return `<div class="bme-task-empty">${_escHtml(emptyText)}</div>`;
  }

  const {
    showSource = false,
    showReason = false,
    startIndex = 0,
    muted = false,
  } = options || {};

  return rules
    .map((rule, index) => {
      const placementText = Array.isArray(rule.placementLabels) && rule.placementLabels.length
        ? rule.placementLabels.join("闂?)
        : "闂傚倸鍊风粈渚€骞栭锔藉亱婵犲﹤瀚々鍙夌節婵犲倻澧涢柡鍜佸墴閺岀喖鎮ч崼鐔哄嚒闂佸憡鐟ラ敃顏堢嵁閺嶎偀鍋撳☉娆樼劷缂佺姵顭囩槐鎺斺偓锝庝悍闊剟鏌″畝瀣М闁挎繄鍋ら、妤呭焵椤掍椒绻嗗┑鍌氭啞閻?;
      const sourceLabel = _formatRegexReuseSourceLabel(rule.sourceType || "");
      const metaBits = [];
      if (showSource) {
        metaBits.push(`闂傚倸鍊风粈渚€骞栭位鍥敇閵忕姷锛熼梺鑲┾拡閸撴繃鎱ㄩ搹顐犱簻闁哄洦顨呮禍楣冩⒑?{sourceLabel}`);
      }
      if (showReason && rule.reason) {
        metaBits.push(rule.reason);
      }
      return `
        <div class="bme-regex-preview-item ${muted ? "is-muted" : ""}">
          <div class="bme-regex-preview-item__head">
            <div class="bme-regex-preview-item__title-group">
              <span class="bme-regex-preview-item__index">#${startIndex + index + 1}</span>
              <span class="bme-regex-preview-item__name">${_escHtml(rule.name || rule.id || "闂傚倸鍊风粈渚€骞栭锔藉亱婵犲﹤瀚々鍙夌節婵犲倻澧曠紒鐘靛█閺屻劑鎮㈤崫鍕戙垽鎮峰▎娆忣洭闁逞屽墮缁犲秹宕曢柆宥嗗亱婵犲﹤鍠氶悞浠嬫煙閹殿喖顣奸柣?)}</span>
            </div>
            <div class="bme-regex-preview-item__badges">
              ${_renderRegexReuseBadges(rule)}
            </div>
          </div>
          <div class="bme-regex-preview-item__details">
            <div class="bme-regex-preview-item__row">
              <span class="bme-regex-preview-item__label">闂傚倸鍊风粈渚€骞栭銈嗗仏妞ゆ劧绠戠壕鍧楁煕濞嗗浚妲洪柣?/span>
              <code>${_escHtml(rule.findRegex || "(缂?findRegex)")}</code>
            </div>
            <div class="bme-regex-preview-item__row">
              <span class="bme-regex-preview-item__label">闂傚倸鍊风粈渚€骞栭鈷氭椽鏁傞柨顖氫壕缂佹绋戦崯浼村汲?/span>
              <code>${_escHtml(_formatRegexReuseReplaceText(rule))}</code>
            </div>
            <div class="bme-regex-preview-item__row">
              <span class="bme-regex-preview-item__label">濠电姷鏁搁崑鐘诲箵椤忓棗绶ら柛鎾楀啫鐏婇柟鍏肩暘閸斿矂寮告笟鈧弻鏇㈠醇濠垫劖笑闂?/span>
              <span>${_escHtml(placementText)}</span>
            </div>
            ${showSource ? `
              <div class="bme-regex-preview-item__row">
                <span class="bme-regex-preview-item__label">闂傚倸鍊风粈渚€骞栭位鍥敇閵忕姷锛熼梺鑲┾拡閸撴繃鎱?/span>
                <span>${_escHtml(sourceLabel)}</span>
              </div>
            ` : ""}
          </div>
          ${metaBits.length ? `
            <div class="bme-regex-preview-item__meta">${_escHtml(metaBits.join(" 闂?"))}</div>
          ` : ""}
        </div>
      `;
    })
    .join("");
}

function _buildRegexReusePopupContent(snapshot = {}) {
  const container = document.createElement("div");
  const sources = Array.isArray(snapshot.sources) ? snapshot.sources : [];
  const activeRules = Array.isArray(snapshot.activeRules) ? snapshot.activeRules : [];
  const stageConfig = snapshot.stageConfig && typeof snapshot.stageConfig === "object"
    ? snapshot.stageConfig
    : {};
  const sourceConfig = snapshot.sourceConfig && typeof snapshot.sourceConfig === "object"
    ? snapshot.sourceConfig
    : {};
  const sourceSummaryText = [
    `global=${sourceConfig.global === false ? "闂? : "闂備浇顕х€涒晠顢欓弽顓炵獥闁圭儤顨呯壕?}`,
    `preset=${sourceConfig.preset === false ? "闂? : "闂備浇顕х€涒晠顢欓弽顓炵獥闁圭儤顨呯壕?}`,
    `character=${sourceConfig.character === false ? "闂? : "闂備浇顕х€涒晠顢欓弽顓炵獥闁圭儤顨呯壕?}`,
  ].join(" / ");
  const stageSummaryText =
    Object.entries(stageConfig)
      .map(([key, value]) => `${key}=${value ? "on" : "off"}`)
      .join(" | ") || "闂?;

  container.innerHTML = `
    <div class="bme-task-tab-body bme-regex-preview-screen">
        <div class="bme-regex-preview-hero">
        <div class="bme-regex-preview-hero__title">闂備浇宕甸崰鎰垝鎼淬垺娅犳俊銈呮噹缁犱即鏌涘☉姗堟敾婵炲懐濞€閺岋絽螣閻戞ǚ鏋欏┑鐐烘？閸楁娊寮婚妸銉㈡斀闁糕剝锚濞咃綁姊虹拠鑼闁哥姵鐗犲濠氬Χ閸ワ絽浜炬繛鎴炵懐閻掕姤銇勯敐鍛骇缂佺粯绻堥崺鈧い鎺戝閸嬪鏌涢鐔稿櫚闁哄鐗犲娲焻閻愯尪瀚板褌鍗抽弻?/div>
        <div class="bme-regex-preview-hero__subtitle">
          闂傚倷绀侀幖顐λ囬锕€鐤炬繝濠傜墛閸嬶繝鏌嶉崫鍕櫣闂傚偆鍨伴—鍐偓锝庝簽閸戣绻涘畝濠侀偗闁哄矉绻濆畷鍫曞煛娴ｅ洨鍋涢湁闁绘ê纾ú鎾煛瀹€瀣М濠碘剝鎮傛俊鐑藉Ψ椤旇崵妫┑鐘殿暯閳ь剙鍟跨痪褔鏌ｉ埄鍐╃濠碉紕鏁婚獮鍥级鐠侯煈鍟嬮梻浣告啞閸旀洖螣婵犲洤鍑犻柍褜鍓欓埞鎴︽倷瀹割喖娈舵繝娈垮櫍缁犳牠銆佸鎰佹Ъ闂侀€涚┒閸旀垿骞冮姀銈嗩棃闁冲搫鍟伴悡鎴︽⒒娴ｅ憡鍟炴繛璇х畵瀹曟娊顢氶埀顒€鐣烽娑欏劅闁抽敮鍋撴俊鎻掔墦閺岀喖鎮欓鈧晶顖炴煕鎼淬垻鐭岀紒杈ㄥ笚濞煎繘濡歌椤︹晲-BME 闂傚倷娴囬褍霉閻戣棄鏋侀柟闂寸缁犵娀鏌熼悙顒併仧闁轰礁锕弻鈥愁吋閸愩劌顬嬮梺宕囩帛濮婅崵妲愰幘瀛樺闁兼祴鍓濋崹鍨嚕閹惰棄閱囬柕澶涘閸橀亶妫呴銏℃悙妞ゆ垵鎳樺畷婵嗩潩閼哥數鍘遍梺缁樺姇濡﹪宕甸悢鍏肩厓鐟滄粓宕滃▎鎴犵濠电姴娲ら悞鍨亜閹哄秷鍏岄柕鍡樺笧缁辨帡骞囬褎鐣跺銈庡弨濞夋洟骞戦崟顖涙優闁告挻鍔戦崐婵嬪蓟閳╁啯濯撮梻鍫熺▓閸嬫挸鈹戦崱娆愭濡炪倖鍔х€靛矂寮崒鐐寸厱闁规澘鍚€缁ㄥ吋淇婂ù瀣壕 Tavern 婵犵數濮甸鏍窗濡ゅ啯宕查柟閭﹀枛缁躲倕霉閻樺樊鍎忛柛銊ュ€归妵鍕冀椤愵澀娌梺鍝勬媼閸撶喖骞冨鈧幃娆撴倻濮楀牏鍚圭紓鍌欓檷閸斿宕￠幎钘夎摕婵炴垶菤閺嬪酣鐓崶銉ュ姕闁轰焦鍎抽埞鎴︽倷鐎涙ê纰嶆繝鈷€鍐╂崳婵″弶鍔欓獮鎺懳旈埀顒勬煁閸ャ劎绡€闂傚牊绋掗ˉ鐘碘偓鍏夊亾婵炴垯鍨洪埛鎺戙€掑顒佹悙濞存粍顨堢槐鎺楀焵椤掍焦濯撮悷娆忓閻濈兘姊虹紒姗嗙劸婵炲懏娲樼粋宥夊Χ閸℃洜绠氬銈嗙墬绾板秶鎷归敍鍕＜闁归偊鍙庡▓婊堟煛瀹€鈧崰鎾跺垝椤撶偐妲堟俊顖欑串缁辩偤姊虹悰鈥充壕婵炲濮撮鍡涙偂閺囩喓绡€闁割煈鍋勬慨鍐磼閵娾晩妫戠紒杈ㄥ浮婵℃悂鏁傛慨鎰檸闁诲孩顔栭崰姘跺极婵犳哎鈧礁螖閸涱厾鍔﹀銈嗗坊閸嬫捇鏌ㄩ弴妯虹伄闁逞屽墯缁嬫帡鈥﹂崶顑锯偓鍛存倻閼恒儱浠梺鎼炲劘閸斿瞼寰婄紒妯镐簻妞ゆ劗濮撮埀顒佺墵楠炲牓濡搁妷銏℃杸闂佽宕樺▔娑㈠春瀹€鍕拺闁告捁灏欓崢娑㈡煕閵娿劌鐓愬ǎ?
        </div>
        <div class="bme-regex-preview-summary">
          <div class="bme-regex-preview-summary__item">
            <span class="bme-regex-preview-summary__label">濠电姷鏁搁崑娑㈩敋椤撶喐鍙忓Δ锝呭枤閺佸鎲告惔銊ョ疄?/span>
            <span class="bme-regex-preview-summary__value">${_escHtml(snapshot.taskType || "闂?)}</span>
          </div>
          <div class="bme-regex-preview-summary__item">
            <span class="bme-regex-preview-summary__label">濠电姷顣藉Σ鍛村磻閸涱収鐔嗘俊顖氱毞閸嬫挸顫濋悡搴ｄ桓濡?/span>
            <span class="bme-regex-preview-summary__value">${_escHtml(snapshot.profileName || snapshot.profileId || "闂?)}</span>
          </div>
          <div class="bme-regex-preview-summary__item">
            <span class="bme-regex-preview-summary__label">濠电姷鏁搁崑娑㈩敋椤撶喐鍙忓Δ锝呭枤閺佸鎲告惔銊ョ疄闁靛ň鏅滈崑鍕攽閸屾凹妲规俊妞煎姂濮婃椽骞愭惔锝囩暤闂佺懓鍟块柊锝夊箖?/span>
            <span class="bme-regex-preview-summary__value">${snapshot.regexEnabled ? "闂備浇顕уù鐑藉箠閹捐绠熼梽鍥Φ閹版澘绀冩い鏃囧亹閻ｉ箖鏌熼崗鑲╂殬闁告柨绉瑰畷? : "闂備浇顕уù鐑藉箠閹捐绠熼梽鍥Φ閹版澘绀冩い鏃囧亹閻撴垿鎮峰鍕叆妞?}</span>
          </div>
          <div class="bme-regex-preview-summary__item">
            <span class="bme-regex-preview-summary__label">濠电姷鏁告慨浼村垂閻撳簶鏋栨繛鎴炴皑閻捇鏌涢锝嗙闁?Tavern</span>
            <span class="bme-regex-preview-summary__value">${snapshot.inheritStRegex ? "闂備浇顕уù鐑藉箠閹捐绠熼梽鍥Φ閹版澘绀冩い鏃囧亹閻ｉ箖鏌熼崗鑲╂殬闁告柨绉瑰畷? : "闂備浇顕уù鐑藉箠閹捐绠熼梽鍥Φ閹版澘绀冩い鏃囧亹閻撴垿鎮峰鍕叆妞?}</span>
          </div>
          <div class="bme-regex-preview-summary__item">
            <span class="bme-regex-preview-summary__label">闂備浇顕ф绋匡耿闁秮鈧箓宕煎┑鎰闂佸壊鍋呭ú鏍几娴ｇ儤鍠愰柣妤€鐗嗙粭姘舵煃闁垮澧甸柡灞剧洴閸╁嫰宕橀妸銉︾槗婵犵數鍋涢崥瀣礉濞嗘挸钃?/span>
            <span class="bme-regex-preview-summary__value">${Number(snapshot.activeRuleCount || activeRules.length || 0)}</span>
          </div>
          <div class="bme-regex-preview-summary__item">
            <span class="bme-regex-preview-summary__label">婵犵數濮烽。浠嬪礈濠靛桅婵犲﹤鐗嗙壕鍧楁煠绾板崬澧柡鍡樼矒閺屸剝寰勭€ｎ亝顔曢梺缁樻⒒閸樠囨倶瀹曞洠鍋撶憴鍕婵炲眰鍔戦妴?/span>
            <span class="bme-regex-preview-summary__value">${_escHtml(snapshot.host?.sourceLabel || "unknown")} 闂?${_escHtml(snapshot.host?.executionMode || snapshot.host?.capabilityStatus?.mode || snapshot.host?.mode || "unknown")}${snapshot.host?.formatterAvailable ? " 闂?formatter" : ""}${snapshot.host?.fallback ? " 闂?fallback" : ""}</span>
          </div>
        </div>
      </div>

      <div class="bme-regex-preview-panel">
        <div class="bme-regex-preview-panel__head">
          <div>
            <div class="bme-regex-preview-panel__title">闂傚倷娴囬褍霉閻戣棄绠犻柟鎹愵嚙妗呭┑鈽嗗灠閻ㄧ兘宕戦幘缁橆棃婵炴垶绮岄顓㈡⒑瀹曞洨甯涙俊顐㈠暞娣囧﹪骞栨担鑲濄劑鏌曟径鍫濆姕閺夊牆鐗嗛埞鎴︽偐椤旇偐浼囧┑鐐差槹缁嬫挾鍒掗弮鍫濋唶闁哄洨鍋為悗顒勬⒑闂堟稓澧曟繛璇х畵瀹曚即宕卞☉娆戝幈闂佸搫娲㈤崝灞剧濠婂牊鐓?/div>
            <div class="bme-regex-preview-panel__subtitle">闂傚倷绀侀幖顐λ囬锕€鐤炬繝濠傜墛閸嬶繝鏌嶉崫鍕櫣闂傚偆鍨堕弻锝夊箣閿濆棭妫勯梺娲诲幗椤ㄥ棝濡甸崟顔剧杸闁圭偓娼欏▍銈夋⒑瀹曞洨甯涙慨濠呭吹濡叉劙骞掑Δ鈧悞鍨亜閹哄秶鍔嶅┑顔界矒閺岀喎鈻撻崹顔界亾闂佺粯绋忛崕闈涱潖濞差亜宸濆┑鐘插閸Ｑ囨⒑缁嬪尅韬い銉︽尵閸掓帡顢橀悙鍨畷闂佸憡娲﹂崑鍡樺鐎ｎ亖鏀介柣妯款嚋瀹搞儵鏌涢悩鍐插摵鐎规洦鍨电粻娑㈠箻椤栨侗娼旈梻浣筋潐閸庤櫕鏅舵惔锝嗘殰婵炴垯鍨洪悡娑樏归敐鍛儓濞寸姾浜埀顒冾潐濞叉﹢銆冩繝鍐х箚闁绘垼濮ら弲婊堟煟閿濆懎顦柛瀣崌椤㈡岸鍩€椤掑嫬钃熼柨鐔哄Т闁卞洦銇勯幇鈺佺仼妤犵偛顑夊娲焻閻愯尪瀚板褜鍨崇槐鎺旀嫚閹绘巻鍋撻懗顖涱棨闂備礁鍟块幖顐﹀箠韫囨稑纾婚柣妯肩帛閻撴洟鏌嶉埡浣告殶闁瑰啿瀚伴弻?Tavern 闂傚倷娴囧畷鐢稿窗閹扮増鍋￠柕澹偓閸嬫挸顫濋悡搴♀拫閻庤娲栫紞濠囥€佸☉銏″€烽悗娑櫳戦悵顐ｇ節閻㈤潧浠﹂柛銊ョ埣閵嗗啴宕奸妷锕€鍓归悗鍏夊亾闁告洦鍓涢崢鎼佹⒑閸涘﹥澶勯柛瀣閸╂盯寮崼鐔哄帾闂佹悶鍎崝宥夋儍閹达附鐓熸慨妯哄閻ｈ櫣鈧鍠楁刊鐣岀不濞戙垺鏅查柛鈩冪懅鍟搁梻鍌氬€风粈渚€骞夐敍鍕殰婵°倕鎳忛崑锟犳煏閸繃澶勬い顐ｆ礀闇夐柛蹇撳悑缂嶆垿鏌涘▎蹇ヨ含妤犵偞鐗楀蹇涘礈瑜嶉惌婵嬫⒑闁偛鑻晶顖炴煥閺囨ê鐏╂い鏇稻缁傛帞鈧綆浜為崐鐐烘⒑闂堟侗鐓梻鍕閳绘挸顫滈埀顒€顫忓ú顏勫窛濠电姴鍊绘禒濂告⒑缁嬭法鏄傞柛濠冩礋閳ワ箓宕堕浣镐缓缂備礁顑堥?/div>
          </div>
        </div>
        <div class="bme-task-note">
          闂傚倸鍊风粈渚€骞栭位鍥敇閵忕姷锛熼梺鑲┾拡閸撴繃鎱ㄩ搹顐犱簻闁哄啫鍊甸幏锟犳煕閵堝棙绀嬮柡灞界Х椤т線鏌涢幘璺烘瀻闁伙絽鍢茶灃闁告劦浜埞蹇涙⒑闂堚晛鐦滈柛姗€绠栭幃?{_escHtml(sourceSummaryText)}<br>
          闂傚倸鍊搁崐鎼佸磹閹间礁鐤柟鎯版閺勩儵鏌″搴″季闁轰礁锕幃姗€鎮欓悽鍨啒闂佹悶鍊栧ú鐔煎蓟瀹ュ牜妾ㄩ梺鍛婃尵閸犲酣鎮惧畡鎷旀棃宕橀鍫氭敽闂備線娼荤€靛矂宕㈡ィ鍐╁仒?{_escHtml(stageSummaryText)}
        </div>
        <div class="bme-regex-preview-list">
          ${_renderRegexReuseRuleList(activeRules, "闂備浇宕甸崰鎰垝鎼淬垺娅犳俊銈呮噹缁犱即鏌涘☉姗堟敾婵炲懐濞€閺岋絽螣閼姐們鍋為梺鍝勭焿缁犳捇寮诲澶婄厸濞达絽鎲″▓鑼磽娴ｅ搫校閻㈩垱甯￠垾锔炬崉閵婏箑纾梺鎯х箰婢э綁濡舵径瀣幐婵炶揪缍佸褔鍩€椤掍胶绠撻柣锝呭槻椤繈顢橀妸褏鐓戝┑鐐舵彧缁插潡骞婇幘瀛樺劅濠电姴鍟扮粻楣冨级閸繂鈷旂紒瀣帛缁绘盯鎳犻鈧弸娑氣偓瑙勬磸閸ㄤ粙銆佸鈧幃銈夊磼濠婂拑绱撮梻鍌欒兌绾爼宕滃┑瀣櫇闁冲搫鎳庣粈澶愭煃瑜滈崜鐔奉潖?, {
            showSource: true,
          })}
        </div>
      </div>

      <div class="bme-regex-preview-panel">
        <div class="bme-regex-preview-panel__head">
          <div>
            <div class="bme-regex-preview-panel__title">濠电姷鏁搁崑娑㈩敋椤撶喐鍙忓Δ锝呭枤閺佸鎲告惔銊ョ疄闁靛ň鏅滈崑鍕煟閹炬娊顎楅柣婵嚸—鍐Χ閸℃娼戦梺绋款儐閹歌崵鎹㈠┑瀣劦妞ゆ帒瀚粻缁樸亜閺冨倸甯堕柣婵囷耿濮婃椽鏌呴悙鑼跺濠⒀勫缁辨帗娼忛妸銉﹁癁閻庤娲栭妶鎼佸箖閵堝棙濯寸紒瀣嚦濡ゅ懏鈷?/div>
            <div class="bme-regex-preview-panel__subtitle">闂傚倷绀侀幖顐λ囬锕€鐤炬繝濠傜墛閸嬶繝鏌曢崼婵囧窛闁告宀搁幃妤呮濞戞瑦鍠愮紒鐐劤閵堟悂寮诲☉銏犲嵆闁靛鍎扮花璇测攽閻愭潙姣嗛柛銉ｅ妿閸橀亶姊洪幐搴㈢叆闁圭⒈鍋呮穱濠囨嚍閵壯咁啎闂佽鍎抽崯鍧椼€傚畷鍥╃＜閺夊牄鍔屽ù顔锯偓瑙勬礀閵堟悂寮幇顓熷劅闁斥晛鍠氶崬鐟扳攽閻樻剚鍟忛柛鐘冲哺楠炲﹪骞樼拠鑼紮濠殿喗绻傜悮顐ｇ瑜版帗鐓曠€光偓閳ь剟宕戦悙鐑樺€块悹鍥梿瑜版帗鏅查柛銉ュ閸旂顪冮妶鍐ㄢ偓鏇㈠箠濮椻偓瀵?<code>input.finalPrompt</code> 闂傚倸鍊搁崐鎼佸磹閹间礁鐤柟鎯版閺勩儵鏌″搴″季闁轰礁锕﹂埀顒€鍘滈崑鎾绘煕閺囥劌浜炴い鎾炽偢閹嘲顭ㄩ崟顐や紝闂侀潧妫旂欢姘剁嵁鐎ｎ喗鏅滈柤鎭掑劜閻濐偊姊虹拠鑼闁稿濞€瀹曟垿骞囬悧鍫濅画濠电娀娼ч鍡涙偂閺囩喓绠鹃柛鈩冾殘缁犱即鏌嶈閸撶喖藟閹捐泛鍨濇い鎾跺仧閺嗗棝鏌嶈閸撶喖宕洪埀顒併亜閹烘垵鈧綊宕甸埀顒勬⒑闂堟稒澶勬い顓炴喘閸┾偓妞ゆ帒瀚☉褔鏌ゅú璇茬仸闁糕斂鍨藉顕€宕煎顏佹櫊閺屾洘寰勯崼婵嗗濠殿喛顫夎ぐ鍐煘閹达附鍊烽悗娑櫭喊宥夋⒑閻熸澘鏆辩紒缁樺笧閸掓帡宕奸妷銉э紲闂佺粯鍔曞?/div>
          </div>
        </div>
        <div class="bme-regex-preview-list">
          ${_renderRegexReuseRuleList(snapshot.localRules, "闂備浇宕甸崰鎰垝鎼淬垺娅犳俊銈呮噹缁犱即鏌涘☉姗堟敾婵炲懐濞€閺岋絽螣閼姐們鍋為梺鍝勭焿缁犳捇寮诲澶婄厸濞达絽鎲″▓鑼磽娴ｅ搫校閻㈩垱甯″﹢渚€姊虹紒妯忚偐鎷冮敃鍌氬惞婵炲棗绻嗛弨鑺ャ亜閺冣偓閸庢娊寮稿☉姘ｅ亾濞堝灝鏋ら柡浣割煼閵嗕礁螖閸涱厾鍔﹀銈嗗坊閸嬫捇鏌ㄩ弴妯虹伈妤犵偞锕㈤、娆撴偂鎼达絽缍侀梻鍌欑窔閳ь剛鍋涢懟顖涙櫠閹殿喚纾奸弶鍫涘妼濞搭喚鈧娲栭妶鎼佸箖閵堝棙濯寸紒瀣嚦濡ゅ懏鈷?, {
            showSource: false,
          })}
        </div>
      </div>

      <details class="bme-debug-details bme-regex-preview-details">
        <summary>闂傚倸鍊风粈渚€骞栭位鍥敇閵忕姷锛熼梺鑲┾拡閸撴繃鎱ㄩ搹顐犱簻闁哄啫鍊瑰▍鏇㈡煃缂佹ɑ顥堟鐐寸墪鑿愭い鎺嗗亾闁诲繆鏅濈槐鎺懳旀担鐟扮３濠殿喖锕ら…宄扮暦閻旂厧鐓涘ù锝嗗絻娴滈箖鏌″搴ｄ粶闁挎繂顦粻锝夋煟濡吋鏆╅柨?/summary>
        <div class="bme-regex-preview-details__body">
        ${
          sources.length
            ? sources.map((source) => `
                <div class="bme-regex-preview-source">
                  <div class="bme-regex-preview-source__head">
                    <div class="bme-regex-preview-source__title">${_escHtml(source.label || source.type || "闂傚倸鍊风粈渚€骞栭锔藉亱婵犲﹤瀚々鏌ユ煟閹邦喖鍔嬮柛瀣€块弻銊╂偄閸濆嫅銏㈢磼閻欐瑥娲﹂悡蹇擃熆閼哥數鈽夋い鈺婂墴閺?)}</div>
                    <div class="bme-regex-preview-source__meta">${_escHtml(_formatRegexReuseSourceState(source))}</div>
                  </div>
                  <div class="bme-task-note">
                    raw=${Number(source.rawRuleCount || 0)} / active=${Number(source.activeRuleCount || 0)}
                    ${source.reason ? `<br>${_escHtml(source.reason)}` : ""}
                  </div>
                  <div class="bme-task-section-label">闂傚倸鍊风粈渚€骞栭锔藉亱婵犲﹤鐗嗙粈鍫熸叏濮楀棗澧婚柣鎺嶇矙濮婂宕奸悢琛℃灁闂佽　鍋撻柨鏇炲€归悡娆撴⒑椤撱劎鐣遍柣蹇氶哺缁绘盯宕楅悡搴☆潚闂佸搫鏈惄顖炵嵁閹烘绠婚柤鎼佹涧濞呮姊绘笟鈧埀顒傚仜閼活垱鏅堕娑楃箚闁告瑥顦ù顕€鏌?/div>
                  <div class="bme-regex-preview-list">
                    ${_renderRegexReuseRuleList(source.previewRules || source.rules, "闂傚倷娴囧畷鍨叏閺夋嚚娲閵堝懐锛熼梺鍦帛鐢晠鎮炴禒瀣拻闁割偆鍠撻埢鎾绘煛閳ь剟鏁冮崒娑氬幍闂備緡鍙忕粻鎴炴櫠閹殿喚纾煎璺侯焾閸嬨垽鏌＄仦鍓ф创妤犵偞锚閻ｇ兘宕堕崱顓犵М闁哄矉缍佹俊鐑藉Ψ閿曗偓濞堟鎮楀▓鍨灈闁诲繑鑹鹃銉╁礋椤掑倻鐦堥梺绋挎湰缁诲秹宕ぐ鎺撯拺閻犲洩灏欑粻鎶芥煕鐎ｎ剙浠滈悡銈嗙節婵犲倻澧曞鍛攽椤旂瓔鐒鹃柛鈺傜墵瀹曟洖顓兼径瀣幈闂佸搫娲㈤崝灞解枍濡崵绠鹃柛蹇曞帶婵秹鏌?)}
                  </div>
                  <div class="bme-task-section-label">闂傚倸鍊风粈渚€骞栭锔藉亱婵犲﹤瀚々鏌ユ煟閹邦剚鎯堢紒鐘侯嚙閳规垿宕掑搴ｅ姼缂備讲鍋撻柛宀€鍋為悡蹇擃熆閼哥數娲存俊缁㈠枛闇夐柣妯诲墯閻掔晫绱掓潏銊﹀鞍闁瑰嘲鎳樺畷顐﹀Ψ閵夘喗姣嗛梻鍌欒兌閹虫挾绮诲澶婂瀭闁芥ê顦遍弳锔界節闂堟侗鍎愰柡鍛倐閺岋絽螣閹稿海褰ч梺?/div>
                  <div class="bme-regex-preview-list">
                    ${_renderRegexReuseRuleList(source.ignoredRules, "婵犵數濮烽弫鎼佸磻濞戞瑥绶為柛銉墮缁€鍫熺節闂堟稒锛旈柤鏉跨仢闇夐柨婵嗘处椤忕喓绱掗幉瀣ɑ缂佺粯绻堝Λ鍐ㄢ槈濞嗘瑧绀婃繝纰樻閸ㄦ澘螞濠靛绠栭悹杞拌濞尖晠鏌ｉ幘宕囧嚬缂併劌銈搁弻锝夊閳轰胶浠梺鍦嚀濞层倝锝炶箛鏃傤浄閻庯綆鈧厞鍥ㄧ厱闁靛绲芥俊鍧楁煛閸℃瑥鈻堥柡宀嬬秮閹垽宕妷锕€娅戦梺璇插閸戝綊宕滈悢椋庢殾?, {
                      showReason: true,
                      muted: true,
                    })}
                  </div>
                </div>
              `).join("")
            : `<div class="bme-task-empty">闂備浇宕甸崰鎰垝鎼淬垺娅犳俊銈呮噹缁犱即鏌涘☉姗堟敾婵炲懐濞€閺岋絽螣閼姐們鍋為梺鍝勭焿缁犳捇寮诲澶婄厸濞达絽鎲″▓鑼磽娴ｅ搫校閻㈩垽绻濆璇测槈濡攱鐎诲┑鈽嗗灥濞咃絾绂掗埡鍛拺婵炶尪顕ф禍婊呯磼婢跺﹤顣抽柛鎺撳浮瀹曞ジ濡烽敂钘夊姃闂佽崵鍠愰悷銉р偓姘煎櫍瀵娊鎮╃紒妯锋嫽婵炶揪绲介幖顐︺€傛總鍛婂仺妞ゆ牓鍊楃弧鈧梺闈涙閹虫﹢銆侀弴銏狀潊闁冲搫鍊归妴鍐⒒娴ｇ懓顕滅紒璇插€块獮濠冩償閵婏箑鈧爼鏌ｉ弬鍨倯闁绘挻绋戦…璺ㄦ崉閾忕懓顣洪梺鍛婃⒐缁海妲愰幒妞烩偓锕傚箣濠靛洨褰庡┑?/div>`
        }
        </div>
      </details>
    </div>
  `;

  return container;
}

async function _openRegexReuseInspector(taskType) {
  if (typeof _actionHandlers.inspectTaskRegexReuse !== "function") {
    toastr.info("闂備浇宕甸崰鎰垝鎼淬垺娅犳俊銈呮噹缁犱即鏌涘☉姗堟敾婵炲懐濞€閺岋絽螣閹稿海褰ф繛瀛樺殠閸婃繈寮婚悢鍏肩劷闁挎洍鍋撻柣蹇涗憾閺岋繝鍩€椤掍胶顩烽悗锝庡亞閸樻悂姊洪崨濠傚Е闁告ê銈搁幃锟犲箛閻楀牏鍘介梺闈涱槶閸庢煡宕甸崶鈹惧亾濞堝灝鏋涢柣蹇旇壘椤曘儵宕熼娑樹壕闁挎繂绨肩花缁樸亜閿旂晫鍙€婵﹨娅ｇ划娆戞崉閵娧呮澖闂備胶顭堢€涒晠鎮￠敓鐘偓浣肝旈埀顒勨€﹂妸鈺侀唶婵犻潧鐗滃Σ瀛樼節閻㈤潧浠滄俊顐ｎ殔闇夋慨姗嗗劦閿濆棛绡€婵﹩鍘鹃崢钘夘渻閵堝骸浜介柛鎾寸懄閹便劑鍩€椤掑嫭鈷戝ù鍏肩懇濡绢噣鏌ｅΔ鍐ㄐ㈡い鏇秮椤㈡宕熼崹顐ｆ珝闂備胶绮崝鏍亹閸愩剱褔寮婚妷锔规嫼?, "ST-BME");
    return;
  }

  try {
    const snapshot = await _actionHandlers.inspectTaskRegexReuse(taskType);
    const content = _buildRegexReusePopupContent(snapshot || {});
    const { callGenericPopup, POPUP_TYPE } = await getPopupRuntime();
    await callGenericPopup(content, POPUP_TYPE.TEXT, "", {
      okButton: "闂傚倸鍊烽懗鍫曗€﹂崼銏″床闁瑰鍋熺粻鎯р攽閻樿弓杩?,
      wide: true,
      large: true,
      allowVerticalScrolling: true,
    });
  } catch (error) {
    console.error("[ST-BME] 闂傚倸鍊烽懗鍫曞箠閹剧粯鍊舵慨妯挎硾缁犱即鏌涘┑鍕姕妞ゎ偅娲熼弻鐔衡偓娑欘焽缁犮儲绻涢梻鏉戝祮闁哄被鍔岄埞鎴﹀幢濡儤顏犻梻浣筋嚙缁绘帡宕版惔銊⑩偓锔炬崉閵婏箑纾梺鎯х箰婢э綁濡舵径瀣幐婵炶揪缍佸褔鍩€椤掍焦绀夐柣蹇擃儔濮婃椽鏌呴悙鑼跺濠⒀冾嚟閳ь剚顔栭崰鏍€﹂柨瀣╃箚闁绘垼妫勫敮闂侀潧顭堥崕閬嶅煕閺囩姷纾介柛灞剧懅閸斿秹鏌涢弮鈧悧鐘诲Υ閸愵喖宸濋柡澶嬪殾閿曞倹鐓欓悗鐢殿焾鏍￠柣?", error);
    toastr.error("闂傚倸鍊烽懗鍫曞箠閹剧粯鍊舵慨妯挎硾缁犱即鏌涘┑鍕姕妞ゎ偅娲熼弻鐔衡偓娑欘焽缁犮儲绻涢梻鏉戝祮闁哄被鍔岄埞鎴﹀幢濡儤顏犻梻浣筋嚙缁绘帡宕版惔銊⑩偓锔炬崉閵婏箑纾梺鎯х箰婢э綁濡舵径瀣幐婵炶揪缍佸褔鍩€椤掍焦绀夐柣蹇擃儔濮婃椽鏌呴悙鑼跺濠⒀冾嚟閳ь剚顔栭崰鏍€﹂柨瀣╃箚闁绘垼妫勫敮闂侀潧顭堥崕閬嶅煕閺囩姷纾介柛灞剧懅閸斿秹鏌涢弮鈧悧鐘诲Υ閸愵喖宸濋柡澶嬪殾閿曞倹鐓欓悗鐢殿焾鏍￠柣?, "ST-BME");
  }
}

function _renderTaskDebugTab(state) {
  const hostCapabilities = state.runtimeDebug?.hostCapabilities || null;
  const runtimeDebug = state.runtimeDebug?.runtimeDebug || {};
  const promptBuild = runtimeDebug?.taskPromptBuilds?.[state.taskType] || null;
  const llmRequest = runtimeDebug?.taskLlmRequests?.[state.taskType] || null;
  const recallInjection = runtimeDebug?.injections?.recall || null;
  const maintenanceDebug = runtimeDebug?.maintenance || null;
  const graphPersistence = runtimeDebug?.graphPersistence || null;

  return `
    <div class="bme-task-tab-body">
      <div class="bme-task-toolbar-row">
        <div class="bme-task-note">
          闂傚倷绀侀幖顐λ囬锕€鐤炬繝濠傜墛閸嬶繝鏌嶉崫鍕櫣闂傚偆鍨伴—鍐偓锝庝簽閸戣绻涘畝濠侀偗闁哄矉绻濆畷鍫曞煛娴ｅ洨鍋涢湁闁绘ê纾ú鎾煛瀹€瀣М濠碘剝鎮傛俊鐑藉Ψ椤旇崵妫┑鐘殿暯閳ь剙鍟跨痪褔鏌熼鐓庘偓鎼侇敋閿濆鍋ㄧ紒瀣硶閸旓箑顪冮妶鍡楃瑐闁绘帪闄勭粋宥夊Χ婢跺鍘甸柣搴㈢⊕椤洭鎯岀仦淇变簻闊洦宀搁崫铏圭磼缂佹娲寸€规洟浜堕、姗€鎮╃喊澶屽惞濠电姷鏁告慨顓㈠磻閹剧粯鐓ユ繛鎴灻銈夋煕鐎ｎ偅宕岀€规洜鍏橀、姗€鎮欓弶鎸庢啟缂傚倸鍊峰ù鍥敋瑜忕划鏃堝醇閺囩偟鐣洪梺鍝勵槼濞夋洟寮抽崱娑欑厓鐟滄粓宕滈悢濂夊殨闁规儼妫勯悞鍨亜閹哄棗浜鹃梺瀹犳椤︾敻鐛鈧獮鍥ㄦ媴缁嬪灝顥愬┑鐘垫暩閸嬫盯鎮ф繝鍥у瀭鐟滅増甯掔粻顖涖亜閹板墎鐣辩紒鈧崘鈹夸簻闁规崘娉涙牎缂佹鍨垮缁樼節鎼粹€茬盎濠电偞娼欓崐鍨暦閹达箑骞㈡繛鎴烆焽閻撴垿鏌熼崗鑲╂殬闁告柨绉瑰鏌ヮ敆閸曨剙鈧爼鏌ｉ幇顖涚【濞存粌缍婇弻锝夋偄閸濄儳鐤勯梺鍝勭焿缁绘繂鐣烽悢鍏碱棃婵炴垶鐭鎾寸節閻㈤潧浠фい鎴炴礋瀹曟劕鈹戠€ｎ剙绁﹂梺閫炲苯澧柕鍡樺笒椤繈鏁愰崨顒€顥氶梻鍌欑閹猜ゅ綘闂佺锕ラ〃鍫澪ｉ幇鏉跨睄闁割偒鍋呴弲鈺呮⒑閼恒儍顏埶囬幎钘夎Е闁稿本鍩冮弨浠嬫煟濡寧鐝紒鈧崘顔界厸鐎光偓鐎ｎ剛袦闂佺硶鏂侀崑鎾愁渻閵堝棗鍧婇柛瀣崌閺屾稒绻濋崒婊呅ㄩ梺璇″灙閸嬫捇姊洪崨濠勨姇婵炲吋鐟ч埀顒佽壘椤︻垶鈥︾捄銊﹀磯濞撴凹鍨伴崜鍗炩攽閻愯尙澧曢柣鏍с偢瀵鎮㈤悜妯虹彴闂佺偨鍎村▍鏇㈡倶瀹ュ應鏀介柨娑樺娴犳粓鏌涙繝鍌涘仴鐎殿噮鍋勯濂稿炊閿旇棄濯伴梻浣藉Г閿氭い锔诲灠椤曪絽螖閸涱喚鍘介梺缁橈耿濞佳囧礉鐎ｎ喗鐓曢柕濞垮劤閿涘秶绱掗瑙勬珚鐎殿喖鐖奸獮瀣籍閳ь剟鎮楁繝姘拺闁绘劘妫勯崝婊堟煕閹炬潙鍝虹€规洜鏁婚幃鈺冩嫚閼碱剦鍟囬梺璇插缁嬫帟鎽梺缁樻惈缂嶄線寮婚悢鑲╁祦闁割煈鍠氭导鍫ユ倵鐟欏嫭绀冪紒璇茬墦瀹曡銈ｉ崘銊ь槰闂佽偐鈷堥崗娆撳磻閺嶎厽鈷掑ù锝呮啞閸熺偤鏌ｉ悤浣哥仸鐎规洖缍婇、妤呭礋椤愩倕濮?
        </div>
        <button class="bme-config-secondary-btn" data-task-action="refresh-task-debug" type="button">
          闂傚倸鍊风粈渚€骞夐敍鍕殰闁跨喓濮寸紒鈺呮⒑椤掆偓缁夋挳鎷戦悢灏佹斀闁绘ê寮舵径鍕煕鐎ｎ偄濮嶉柡灞诲€濆畷顐﹀Ψ椤旇姤鐦滈梻?
        </button>
      </div>

      <div class="bme-task-debug-grid">
        <div class="bme-config-card">
          ${_renderTaskDebugHostCard(hostCapabilities)}
        </div>
        <div class="bme-config-card">
          ${_renderTaskDebugGraphPersistenceCard(graphPersistence)}
        </div>
        <div class="bme-config-card">
          ${_renderTaskDebugMaintenanceCard(maintenanceDebug)}
        </div>
        <div class="bme-config-card">
          ${_renderTaskDebugPromptCard(state.taskType, promptBuild)}
        </div>
        <div class="bme-config-card">
          ${_renderTaskDebugLlmCard(state.taskType, llmRequest)}
        </div>
        <div class="bme-config-card">
          ${_renderTaskDebugInjectionCard(recallInjection)}
        </div>
      </div>
    </div>
  `;
}

function _renderTaskDebugMaintenanceCard(maintenanceDebug) {
  const lastAction = maintenanceDebug?.lastAction || null;
  const lastUndoResult = maintenanceDebug?.lastUndoResult || null;

  if (!lastAction && !lastUndoResult) {
    return `
      <div class="bme-config-card-title">缂傚倸鍊搁崐鎼佸磹妞嬪海鐭嗗〒姘ｅ亾闁诡喗妞芥俊鎼佹晜閽樺浼庨梻渚€娼х换鍫ュ垂閾忓厜鍋撳顒夌吋闁哄被鍔戝顕€宕堕‖顔芥崌閺岀喖鎮滈幋鎺撳枤闂佸搫鐭夌徊鍊熺亽闂佸壊鐓堥崰姘跺储椤愶附鈷?/div>
      <div class="bme-config-help">闂備浇宕甸崰鎰垝鎼淬垺娅犳俊銈呮噹缁犱即鏌涘☉姗堟敾婵炲懐濞€閺岋絽螣閹稿海褰ф繛瀛樺殠閸婃牗绌辨繝鍥舵晬婵犻潧妫楅幆鐐测攽椤旂》韬紒鐘崇墵瀵鏁撻悩鏌ュ敹濠电姴鐏氶崝鏍ㄦ櫏濠电姷鏁搁崑鐐哄箲娓氣偓瀹曟椽寮借閻掕棄鈹戦悩瀹犲缂佺媴缍侀弻锝呂熼幐搴ｅ涧闂佸磭绮ú鐔奉潖閾忚鍏滈柛娑卞灠閻楁岸姊虹粙鍖℃敾闁绘濮撮悾鐤亹閹烘嚦鈺呮煃鏉炴媽鍏屾い鏃€甯″娲濞戞艾顣哄銈忕細閸楀啿顕ｉ銏╂建闁逞屽墴閹繝顢曢敃鈧悙濠囨偣妤︽寧銆冪紒銊ょ矙濮婃椽宕ㄦ繝鍕櫑闂備礁搴滅徊鐐┍?/div>
    `;
  }

  return `
    <div class="bme-config-card-head">
      <div>
        <div class="bme-config-card-title">缂傚倸鍊搁崐鎼佸磹妞嬪海鐭嗗〒姘ｅ亾闁诡喗妞芥俊鎼佹晜閽樺浼庨梻渚€娼х换鍫ュ垂閾忓厜鍋撳顒夌吋闁哄被鍔戝顕€宕堕‖顔芥崌閺岀喖鎮滈幋鎺撳枤闂佸搫鐭夌徊鍊熺亽闂佸壊鐓堥崰姘跺储椤愶附鈷?/div>
        <div class="bme-config-card-subtitle">
          闂傚倸鍊风粈渚€骞栭锔藉亱闁告劦鍠栫壕濠氭煙閹规劦鍤欑紒鐙欏洦鐓冮柛婵嗗閳ь剚鎮傞幃姗€鏁愰崶鈺冿紲闂佸搫鍟犻崑鎾寸箾閸忚偐鎳囬柛鈹垮灪閹棃濡搁敂鑺ョ彨闂備礁鎲″ú锕傚礈濮樿泛鐓濋柡鍥ュ灪閳锋垹鐥鐐村櫧闁割偒浜弻娑欑節閸愵亝鍒涘銈冨灪閻熲晛鐣烽崼鏇ㄦ晜闁稿本鐟﹂惈蹇涙⒒娴ｅ憡鎯堟繛灞傚姂瀹曟垿鎮欑喊妯轰壕婵﹩鍘鹃崣鈧梺鍝勭焿缁绘繂鐣烽悡搴僵妞ゆ垵鐏濋ˉ姘舵⒒娴ｅ憡鎯堟い锔诲亰瀵彃顭ㄩ崼婵嗙€悗瑙勬礀濞层劑宕″鑸电厸濠㈣泛顑呴悘宥夋煛鐎ｎ亪鍙勯柡灞界Ч閸┾剝鎷呴崨濠冾唹闂佽娴烽弫鎼佸极鐠囧樊娼栭柣鎴炆戦崕鐔兼煙閹冨笭濠㈣娲滅槐鎾诲磼濮橆兘鍋撻悜鑺ュ€块柨鏇炲€哥粻鏉库攽閻樺磭顣查柛濠呮硾椤潡鎳滈棃娑橆潓閺?
        </div>
      </div>
      <span class="bme-task-pill">${_escHtml(lastAction?.action || lastUndoResult?.action || "maintenance")}</span>
    </div>
    ${_renderDebugDetails("闂傚倸鍊风粈渚€骞栭锔藉亱闁告劦鍠栫壕濠氭煙閹规劦鍤欑紒鐙欏洦鐓冮柛婵嗗閳ь剚鎮傞幃姗€鍩￠崒婊咁啎闂佹寧绻傛绋库枍瀹ュ棭娈?, lastAction)}
    ${_renderDebugDetails("闂傚倸鍊风粈渚€骞栭锔藉亱闁告劦鍠栫壕濠氭煙閹规劦鍤欑紒鐙欏洦鐓冮柛婵嗗閳ь剚鎮傞幃姗€鏁冮崒娑氬幍闂佸憡绋戦敃锕傚箠閸ヮ剚鐓涢悘鐐额嚙婵倿鏌涢埞鎯т壕?, lastUndoResult)}
  `;
}

function _renderTaskDebugGraphPersistenceCard(graphPersistence) {
  if (!graphPersistence) {
    return `
      <div class="bme-config-card-title">闂傚倸鍊烽悞锕傚箖閸洖纾块柟缁樺笧閺嗭附淇婇娆掝劅婵炲皷鏅犻弻鏇熺箾閻愵剚鐝旂紓浣哄У濠㈡﹢婀侀梺鎸庣箓椤﹁棄螞閹达附鐓熼柨婵嗗閻瑩鏌＄仦鍓ф创鐎殿喕绮欐俊姝岊槻闁冲嘲鐗婄换婵嗏枔閸喗鐏嶉梺璇″枛閸婂潡鎮伴鈧崺鈧?/div>
      <div class="bme-config-help">闂備浇宕甸崰鎰垝鎼淬垺娅犳俊銈呮噹缁犱即鏌涘☉姗堟敾婵炲懐濞€閺岋絽螣閹稿海褰ф繛瀛樺殠閸婃牗绌辨繝鍥舵晬婵犻潧妫楅幆鐐测攽椤旂》韬紒鐘崇墵瀵鏁撻悩鏌ュ敹濠电姴鐏氶崝鏍懅濠电姷鏁搁崑娑㈡偤閵娾斁鈧箓宕堕鈧粻顖涖亜閹板墎鐣辩痪顓涘亾闂備胶绮崝鏇炍熸繝鍌ょ劷闂侇剙绉甸悡?闂傚倸鍊风粈浣虹礊婵犲洤鐤鹃柟缁樺俯濞撳鏌熼悜妯烩拻濞戞挸绉电换娑㈠幢濡纰嶇紓浣插亾鐎光偓閸曨剛鍘搁悗瑙勬惄閸犳牜鈧凹鍓欓妴鎺楀箛閻楀牃鎷虹紓鍌欑劍钃遍悗鍨懃闇夐柨婵嗘缁茶霉?/div>
    `;
  }

  return `
    <div class="bme-config-card-head">
      <div>
        <div class="bme-config-card-title">闂傚倸鍊烽悞锕傚箖閸洖纾块柟缁樺笧閺嗭附淇婇娆掝劅婵炲皷鏅犻弻鏇熺箾閻愵剚鐝旂紓浣哄У濠㈡﹢婀侀梺鎸庣箓椤﹁棄螞閹达附鐓熼柨婵嗗閻瑩鏌＄仦鍓ф创鐎殿喕绮欐俊姝岊槻闁冲嘲鐗婄换婵嗏枔閸喗鐏嶉梺璇″枛閸婂潡鎮伴鈧崺鈧?/div>
        <div class="bme-config-card-subtitle">
          闂傚倸鍊风粈渚€骞栭锔藉亱闁告劦鍠栫壕濠氭煙閹规劦鍤欑紒鐙欏洦鐓冮柛婵嗗閳ь剚鎮傞幃姗€鏁愰崶鈺冿紲闂佸搫鍟犻崑鎾寸箾閸忚偐鎳囬柛鈹垮灪閹棃濡搁妷褌绱滈梻浣瑰劤濞存岸宕戦崱娑栤偓鍛搭敇閵忥紕鍘介梺缁樏Ο濠囧磿韫囨洍鍋撶憴鍕闁告挻宀搁獮鍫ュΩ閳哄倸鈧兘鎮楀☉娅亪锝為敓鐘斥拺闁荤喐澹嗛幗鐘绘偨椤栨粌浠遍柟顔惧厴婵偓闁靛牆妫涢崢閬嶆⒑瑜版帒浜伴柛姗€绠栭獮濠囧礃閳哄啰顔曢梺鍛婄懃椤﹁鲸鏅堕悽纰樺亾鐟欏嫭鐦婚柕鍫濇川閺夌鈹戦绛嬬劸濡炲瓨鎮傞、娆忣吋閸モ晝锛濋梺绋挎湰閻熝囧礉瀹ュ鐓欑紒瀣儥閻撳ジ鏌熼缂存垵顕ラ崟顖氱疀妞?
        </div>
      </div>
      <span class="bme-task-pill">${_escHtml(graphPersistence.loadState || "unknown")}</span>
    </div>
    <div class="bme-debug-kv-list">
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">闂傚倸鍊烽懗鍫曞储瑜嶉悾鐑筋敆閸曨剚娅囬梺闈涚墕椤︻垱顢?/span>
        <span class="bme-debug-kv-value">${_escHtml(graphPersistence.chatId || "闂?)}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">闂傚倸鍊风粈渚€骞夐敓鐘偓锕傚炊椤掆偓缁愭骞栫划鐟扮厬?/span>
        <span class="bme-debug-kv-value">${_escHtml(graphPersistence.reason || "闂?)}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">闂傚倷娴囬褏鎹㈤幇顔藉床闁瑰濮靛畷鏌ユ煕閳╁啰鈯曢柛搴★攻閵囧嫰寮介妸銉у姲闂佸搫顑呴柊锝夊蓟瀹ュ鐓涘ù锝呮啞濞堟彃鈹?/span>
        <span class="bme-debug-kv-value">${_escHtml(String(graphPersistence.attemptIndex ?? 0))}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">闂備浇宕甸崰鎰垝鎼淬垺娅犳俊銈呮噹缁犱即鏌涘☉姗堟敾婵?revision</span>
        <span class="bme-debug-kv-value">${_escHtml(String(graphPersistence.graphRevision ?? 0))}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">闂傚倸鍊风粈渚€骞栭锔藉亱闁告劦鍠栫壕濠氭煙閹规劦鍤欑紒鐙欏洦鐓冮柛婵嗗閳ь剚鎮傞幃姗€濡烽埡鍌滃幈闂佽鎯岄崹宕囧姬閳ь剙螖閻橀潧浠﹂柛鏃€鐗犻獮蹇涘川椤曞懏效闁硅壈鎻徊鎯掑畝鍕拻?revision</span>
        <span class="bme-debug-kv-value">${_escHtml(String(graphPersistence.lastPersistedRevision ?? 0))}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">闂傚倸鍊风粈渚€骞栭锔藉亱闁告劦鍠栫壕濠氭煙閹规劦鍤欑紒鐙欏洦鐓冮柛婵嗗閳ь剚鎮傞幃姗€濡烽埡鍌滃幈闂佽鎯岄崹宕囧姬閳ь剙螖閻橀潧浠﹂悽顖楀墲娣囧﹪鎮滈挊澹┿劑鏌曟竟顖氭啗?revision</span>
        <span class="bme-debug-kv-value">${_escHtml(String(graphPersistence.lastAcceptedRevision ?? 0))}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">闂傚倸鍊风粈浣革耿闁秴纾块柕鍫濇处閺嗘粓鏌嶉妷锔剧獮闁挎繂顦伴弲婊堟煟閿濆懎顦柡瀣墪椤啴濡堕崱妯烘殫婵犳鍠氶弫濠氬箖?revision</span>
        <span class="bme-debug-kv-value">${_escHtml(String(graphPersistence.queuedPersistRevision ?? 0))}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">闂備浇顕ф鎼佹倶濮橆剦鐔嗘慨妞诲亾妤犵偛锕獮鍥级鐠恒劋绱滄繝纰樻閸ㄤ即宕ョ€ｎ偄鍨斿┑鍌氭啞閻撳繘鏌涢锝囩畺闁革絽缍婇弻锟犲川椤旇棄鈧劙鏌?/span>
        <span class="bme-debug-kv-value">${_escHtml(graphPersistence.pendingPersist ? "闂? : "闂?)}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">闂備浇宕甸崰鎰垝瀹ュ拋鐔嗘俊顖濇閺嗭附銇勯幒鎴濐仾闁稿鍊栫换娑㈠幢濡櫣顑傞梺姹囧€愰崑鎾翠繆閻愵亜鈧牠宕濋幋锕€纾归柡鍥╁剱閸?/span>
        <span class="bme-debug-kv-value">${_escHtml(graphPersistence.shadowSnapshotUsed ? "闂備浇顕ф绋匡耿闁秮鈧箓宕煎┑鎰闂佸憡鎸烽悞锕傚汲濠婂牊鍊甸梻鍫熺⊕閹茬鈽? : "闂傚倸鍊风粈渚€骞栭锔藉亱婵犲﹤瀚々鍙夌箾閸℃ê濮夌紒鐘荤畺閺屾盯濡烽鐓庮潽闂?)}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">闂傚倸鍊风粈渚€骞夐敓鐘茬闁哄稁鍘介崑锟犳煏閸繃澶勭€规洖寮堕幈銊ノ熼幐搴ｃ€愮紓?/span>
        <span class="bme-debug-kv-value">${_escHtml(graphPersistence.writesBlocked ? "闂備浇顕уù鐑藉箠閹捐绠熼梽鍥Φ閹版澘绀冩い鏃囧亹閻ｉ箖鏌熼崗鑲╂殬闁告柨绉瑰畷? : "闂傚倸鍊风粈渚€骞栭锔藉亱婵犲﹤瀚々鍙夌節婵犲倻澧曠紒鐘冲哺楠炴牕菐椤掆偓婵′粙鏌?)}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">濠电姷鏁搁崑鐐哄垂閸洖绠伴柟缁㈠枛绾惧鏌熼崜褏甯涢柣鎾跺Х閳ь剛鎳撶€氼厽绔熼崱娑樼闁绘绮悡鍐喐濠婂牆纾块柟闂寸缁€鍐┿亜韫囨挻锛旂紒杈ㄥ▕濮?/span>
        <span class="bme-debug-kv-value">${_escHtml(graphPersistence.persistMismatchReason || "闂?)}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">Commit Marker</span>
        <span class="bme-debug-kv-value">${_escHtml(
          graphPersistence.commitMarker
            ? [
                `rev ${Number(graphPersistence.commitMarker.revision || 0)}`,
                graphPersistence.commitMarker.accepted === true ? "accepted" : "pending",
                graphPersistence.commitMarker.storageTier || "",
              ]
                .filter(Boolean)
                .join(" 闂?")
            : "闂?,
        )}</span>
      </div>
    </div>
    ${_renderDebugDetails("闂傚倸鍊烽悞锕傚箖閸洖纾块柟缁樺笧閺嗭附淇婇娆掝劅婵炲皷鏅犻弻鏇熺箾閻愵剚鐝旂紓浣哄У濠㈡﹢婀侀梺鎸庣箓椤﹁棄螞閹达附鐓熼柨婵嗗閻瑩鏌＄仦鍓ф创鐎殿喕绮欐俊姝岊槻闁冲嘲锕ら—鍐Χ閸℃顦ㄩ梺鐑╂櫓閸ㄥ爼鎮?, graphPersistence)}
  `;
}

function _renderTaskDebugHostCard(hostCapabilities) {
  if (!hostCapabilities) {
    return `
      <div class="bme-config-card-title">闂傚倷娴囬褍霉閻戣棄绠犻柟鎹愵嚙妗呭┑鈽嗗灠閻ㄧ兘宕戦幘缁橆棃婵炴垶绮岄顓烆渻閵堝倹娅呴柕鍫濇啞娣囧﹪鎮滈懞銉︽珖闂侀€炲苯澧€垫澘瀚鍏煎緞鐎ｎ剙骞楁繝纰樻閸ㄤ即鎮樺┑瀣亗闁规壆澧楅悡?/div>
      <div class="bme-config-help">闂備浇宕甸崰鎰垝鎼淬垺娅犳俊銈呮噹缁犱即鏌涘☉姗堟敾婵炲懐濞€閺岋絽螣閹稿海褰ф繛瀛樺殠閸婃牗绌辨繝鍥舵晬婵犻潧妫楅幆鐐测攽椤旂》韬紒鐘崇墵瀵鏁撻悩鏌ュ敹濠电姴鐏氶崝鏍懅濠碉紕鍋戦崐鏍ь潖瑜版帗鍋嬫俊銈呭暟閻瑥顭跨捄铏圭伇缁炬儳鍚嬫穱濠囶敍濞戞碍鍣у銈忓閺佸鎮伴鈧獮鎺懳旈埀顒€鏁梻渚€娼ч¨鈧紒鐘冲灥閵嗘帡骞囬悧鍫氭嫼缂傚倷鐒﹁摫閻庡灚鐟ラ湁闁挎繂妫楃徊璇裁?/div>
    `;
  }

  const capabilityNames = ["context", "worldbook", "regex", "injection"];
  return `
    <div class="bme-config-card-head">
      <div>
        <div class="bme-config-card-title">闂傚倷娴囬褍霉閻戣棄绠犻柟鎹愵嚙妗呭┑鈽嗗灠閻ㄧ兘宕戦幘缁橆棃婵炴垶绮岄顓烆渻閵堝倹娅呴柕鍫濇啞娣囧﹪鎮滈懞銉︽珖闂侀€炲苯澧€垫澘瀚鍏煎緞鐎ｎ剙骞楁繝纰樻閸ㄤ即鎮樺┑瀣亗闁规壆澧楅悡?/div>
        <div class="bme-config-card-subtitle">
          闂備浇宕甸崰鎰垝鎼淬垺娅犳俊銈呮噹缁犱即鏌涘☉姗堟敾婵炲懐濞€閺岋絽螣濞嗘儳娈紓浣哄Х閺佸寮婚悢鐓庝紶闁告洦鍘滈敐鍡愪簻闁归偊浜為惌娆撴煛?SillyTavern 闂傚倸鍊烽悞锕傛儑瑜版帒绀夌€光偓閳ь剟鍩€椤掍礁鍤柛姗€绠栧顐︻敊闁款垰浜炬繛鎴烆伆閹寸偞鍙忔繝濠傜墛閻撳繐鈹戦悩鑼闁伙綁浜堕弻娑㈠箻閹绘帒绁梺鍝勬湰閻╊垶鐛崶顒夋晩闂傚倹娼欑€垫煡姊?
        </div>
      </div>
      <span class="bme-task-pill ${hostCapabilities.available ? "is-builtin" : ""}">
        ${hostCapabilities.mode || (hostCapabilities.available ? "available" : "unavailable")}
      </span>
    </div>
    <div class="bme-debug-kv-list">
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">闂傚倸鍊峰ù鍥敋閺嶎厼绀堟繝闈涙閺嗭箓鏌涢…鎴濅簼闁告瑥绻橀弻鐔兼⒒鐎靛壊妲紓?/span>
        <span class="bme-debug-kv-value">${_escHtml(hostCapabilities.available ? "闂傚倸鍊风粈渚€骞夐敓鐘冲仭妞ゆ牜鍋涢崹鍌炴煙閹増顥夐柡? : "濠电姷鏁搁崑鐐哄垂閸洖绠伴柛婵勫劤閻挾鐥幆褜鍎嶅ù婊冪秺閺岋紕浠︾拠鎻掑闂?)}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">闂傚倷娴囧畷鍨叏閺夋嚚娲Χ婢跺浠遍梺闈涱焾閸?/span>
        <span class="bme-debug-kv-value">${_escHtml(hostCapabilities.fallbackReason || "闂?)}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">闂傚倸鍊搁…顒勫磻閸曨個褰掑磼閻愯尙锛涢梺绯曞墲缁嬫垿鎯屽Δ鍛婵烇綆鍓欐俊浠嬫煕鐎ｎ亶鍎旈柡灞剧洴椤㈡洟濡堕崨顔锯偓楣冩⒑?/span>
        <span class="bme-debug-kv-value">${_escHtml(String(hostCapabilities.snapshotRevision ?? "闂?))}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">闂傚倸鍊搁…顒勫磻閸曨個褰掑磼閻愯尙锛涢梺绯曞墲缁嬫垿鎯屽Δ鍛婵烇綆鍓欐俊鑲╃磼椤愩垻效闁哄本鐩、鏇㈡晲閸℃瑯妲伴梻?/span>
        <span class="bme-debug-kv-value">${_escHtml(_formatTaskProfileTime(hostCapabilities.snapshotCreatedAt))}</span>
      </div>
    </div>
    <div class="bme-task-section-label">闂傚倸鍊风粈渚€骞夐敍鍕殰闁圭儤鍤﹀☉妯锋斀閻庯綆鈧厹鍎抽埀顒€绠嶉崕閬嵥囨导鏉戝惞闁告洦鍨遍悡銏′繆椤栨瑨顒熸俊鎻掓啞閵?/div>
    <div class="bme-debug-capability-list">
      ${capabilityNames
        .map((name) => {
          const capability = hostCapabilities[name] || {};
          return `
            <div class="bme-debug-capability-item">
              <div class="bme-debug-capability-head">
                <span class="bme-debug-capability-title">${_escHtml(name)}</span>
                <span class="bme-task-pill ${capability.available ? "is-builtin" : ""}">
                  ${_escHtml(capability.mode || (capability.available ? "available" : "unavailable"))}
                </span>
              </div>
              <div class="bme-debug-capability-desc">
                ${_escHtml(capability.fallbackReason || "闂?)}
              </div>
            </div>
          `;
        })
        .join("")}
    </div>
  `;
}

function _renderTaskDebugPromptCard(taskType, promptBuild) {
  if (!promptBuild) {
    return `
      <div class="bme-config-card-title">闂傚倸鍊风粈渚€骞栭锔藉亱闁告劦鍠栫壕濠氭煙閹规劦鍤欑紒?Prompt 缂傚倸鍊搁崐鎼佸磹妞嬪海鐭嗗ù锝堛€€閸嬫挸顫濋悡搴ｄ桓闁?/div>
      <div class="bme-config-help">闂備浇宕甸崰鎰垝鎼淬垺娅犳俊銈呮噹缁犱即鏌涘☉姗堟敾婵炲懐濞€閺岋絽螣閾忕櫢绱炲銈傛櫇閸忔﹢骞冭ぐ鎺戠倞闁靛鍎崇粊宄邦渻閵堝骸浜栭柛濠冪箓椤曪綁宕奸弴鐐靛幐闂佺顑呴悘姘跺垂閸ф绠氶柍褜鍓熼弻娑樷槈濞嗘劗绋囬柣搴㈣壘椤︻垶鈥︾捄銊﹀磯濞撴凹鍨伴崜杈ㄧ箾鐎电校闁挎洏鍨归锝夊醇閺囩偟鍘搁梺绋挎湰濮樸劍绂掗婊呯＝濞达綀顫夐埛鎰箾閸忚偐鎳囬柛?prompt 缂傚倸鍊搁崐鎼佸磹妞嬪海鐭嗗ù锝堛€€閸嬫挸顫濋悡搴ｄ桓闁芥鍠庨埞鎴︽偐閸欏娅ч梺姹囧€愰崑鎾翠繆閻愵亜鈧牠宕濋幋锕€纾归柡鍥╁剱閸ゆ洖螖閿濆懎鏆為柣?/div>
    `;
  }

  return `
    <div class="bme-config-card-head">
      <div>
        <div class="bme-config-card-title">闂傚倸鍊风粈渚€骞栭锔藉亱闁告劦鍠栫壕濠氭煙閹规劦鍤欑紒?Prompt 缂傚倸鍊搁崐鎼佸磹妞嬪海鐭嗗ù锝堛€€閸嬫挸顫濋悡搴ｄ桓闁?/div>
        <div class="bme-config-card-subtitle">
          濠电姷鏁搁崑娑㈩敋椤撶喐鍙忓Δ锝呭枤閺佸鎲告惔銊ョ疄?${_escHtml(taskType)} 闂傚倸鍊风粈渚€骞栭锔藉亱闁告劦鍠栫壕濠氭煙閹规劦鍤欑紒鐙欏洦鐓冮柛婵嗗閳ь剚鎮傞幃姗€鏁愰崶鈺冿紲闂佸搫鍟犻崑鎾寸箾閸忚偐鎳囬柛鈹垮灪閹棃濡搁敂鑺ョ彨闂備礁鎲″ú锕傚礈濞嗘挻鍊块柟闂寸劍閻撶喖骞栫划鐟板⒉閻犳劧绻濋弻娑氣偓锝庡墮閺嬫梹淇婇崣澶婂妞ゃ垺妫冨畷鐓庘攽閸偄鏁介梻鍌欑濠€閬嶅磿閵堝拋娼栭悹鍥ㄧゴ閺嬫牠鏌曡箛瀣偓鏍偂濞戙垺鍊甸柨婵嗛娴滄粍绻涢崼銏犫枅闁?
        </div>
      </div>
      <span class="bme-task-pill">${_escHtml(_formatTaskProfileTime(promptBuild.updatedAt))}</span>
    </div>
    <div class="bme-debug-kv-list">
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">濠电姷顣藉Σ鍛村磻閸涱収鐔嗘俊顖氱毞閸嬫挸顫濋悡搴ｄ桓濡?/span>
        <span class="bme-debug-kv-value">${_escHtml(promptBuild.profileName || promptBuild.profileId || "闂?)}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">闂傚倸鍊烽懗鍫曪綖鐎ｎ喖绀嬮柛顭戝亞閺嗭箓姊绘担鍛婃儓婵☆偅鐩畷浼村冀椤撶偠鎽?/span>
        <span class="bme-debug-kv-value">${_escHtml(String(promptBuild.debug?.renderedBlockCount ?? promptBuild.renderedBlocks?.length ?? 0))}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">婵犵數濮烽弫鎼佸磻濞戔懞鍥敇閵忕姷顦悗鍏夊亾闁告洦鍋嗛悡鎴︽⒑缁洖澧查柣鐕傞檮閸掑﹥绺介崨濠勫帗闂侀潧顦崕閬嶅汲闁秵鐓?/span>
        <span class="bme-debug-kv-value">${_escHtml(String(promptBuild.debug?.hostInjectionPlanCount ?? promptBuild.debug?.hostInjectionCount ?? 0))}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">缂傚倸鍊搁崐椋庣矆娓氣偓钘濇い鏇楀亾闁诡喚鍋ら弫鍐焵椤掑嫭鏅濋柕蹇婂墲婵绱掗娑欑妞ゎ偄绉瑰娲礈閹绘帊绨介梺鍝ュТ缁夎泛危?/span>
        <span class="bme-debug-kv-value">${_escHtml(String(promptBuild.debug?.executionMessageCount ?? promptBuild.executionMessages?.length ?? promptBuild.privateTaskMessages?.length ?? 0))}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">EJS 闂傚倸鍊烽懗鍓佸垝椤栫偐鈧箓宕奸妷銉︽К闂佸搫绋侀崢濂告倿?/span>
        <span class="bme-debug-kv-value">${_escHtml(promptBuild.debug?.ejsRuntimeStatus || "unknown")}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">濠电姷鏁搁崑鐐哄垂閸洖绠板┑鐘崇閸嬪绻濇繝鍌滃闁汇倗鍋撻妵鍕箛閸撲焦鍋ч梺?/span>
        <span class="bme-debug-kv-value">${_escHtml(promptBuild.debug?.effectivePath?.worldInfo || "unknown")}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">濠电姷鏁搁崑鐐哄垂閸洖绠板┑鐘崇閸嬪绻濇繝鍌滃闁汇倗鍋撻妵鍕箛閸撲焦鍋ч梺宕囩帛濞茬喖寮婚妸鈺佹闁割煈鍠掗幐鍐╃節閵忥絾纭鹃悗姘嵆楠?/span>
        <span class="bme-debug-kv-value">${_escHtml(promptBuild.debug?.worldInfoCacheHit ? "闂傚倸鍊风粈渚€骞夐敍鍕煓闁圭儤顨呴崹鍌涚節闂堟侗鍎愰柛? : "闂傚倸鍊风粈渚€骞栭锔藉亱婵犲﹤瀚々鍙夌節婵犲倻澧曠紒鐘靛█閺屽秹鍩℃担鍛婃闂?)}</span>
      </div>
    </div>
    ${_renderDebugDetails("闂傚倷娴囬褎顨ョ粙鍖¤€块梺顒€绉寸壕濠氭煏閸繃濯奸柣搴ゅ煐閵囧嫰寮介顫捕缂備胶濯崳锝夊蓟閿熺姴鐐婇柨婵嗘濞呮岸姊虹粙娆惧剱闁圭懓娲悰顕€骞掑Δ鈧崡鎶芥煟濮椻偓濞佳囧极閸洘鐓?, promptBuild.debug?.effectivePath || null)}
    ${_renderDebugDetails("婵犵數濮烽弫鎼佸磻閻愬搫绠扮紒瀣儥閸ゆ洟鏌涢锝嗙闁稿鍊块幃妤呮晲鎼粹剝鐏堥柣鐔哥懕缁犳捇鐛弽銊︾秶闁告挆鍚锋垿姊烘导娆戠М濞存粌鐖煎璇测槈濠婂孩歇婵＄偑鍊戦崝宥夊礉濡も偓鍗遍柟閭﹀厴閺嬪酣鏌熼幆褏锛嶆い鏂挎处缁绘繈濮€閿濆懐鍘梺鍛婃⒐濞叉粓寮鑲╂殾闁搞儮鏅濋敍婵嬫⒑閸涘﹤濮堥柛搴″暱閳诲秴顓兼径瀣帾闂佺硶鍓濋〃鍛搭敆閵忋倖鐓欐い鏍ㄧ⊕椤ュ棛绱掗悩宕囨创濠碉紕鏌夐ˇ瀛樸亜?, promptBuild.renderedBlocks)}
    ${_renderDebugDetails("闂傚倷娴囬褎顨ョ粙鍖¤€块梺顒€绉寸壕濠氭煏閸繃濯奸柣搴ゅ煐閵囧嫰寮介顫捕缂備胶濮伴崕鎶藉箟閹间礁绠ｉ柨鏃囥€€閸嬫挻绗熼埀顒勭嵁鐎ｎ亖鏀介柛鎰ㄦ櫓濞兼棃姊绘担绋款棌闁稿妫濆畷鏉款吋閸ヮ煈娼熼梺鍝勭▉閸樿偐绮昏ぐ鎺撶厸濠㈣泛顑呴悘鈺冪磼閻樺崬宓嗛柡?, promptBuild.executionMessages || promptBuild.privateTaskMessages || null)}
    ${_renderDebugDetails("缂傚倸鍊搁崐椋庢閿熺姴鍨傞梻鍫熺〒閺嗭箓鏌ｉ姀銈嗘锭闁搞劍绻冪换娑橆啅椤旇崵鐩庣紓浣哄Х閺佸寮婚悢鍏肩劷闁挎洍鍋撻柡瀣煥闇夐柣妯虹－濞叉挳鏌熼鑲╃Ш鐎规洘鍎奸ˇ鎾煃鐠囪尙鐏辩紒杈ㄥ笚濞煎繘濡歌閸ｄ即鎮楃憴鍕妞ゃ劌锕獮鍐焺閸愨晛鍔呭銈嗘煥閸氬鈻嶅澶嬧拺闁煎鍊曢弸鎴︽煟閻旀潙鍔氶摶鐐翠繆閵堝倸浜鹃梻鍥ь槹閹便劌顪冪拠韫闂備浇妗ㄧ粈浣虹矓閼哥數顩烽柨鏇炲€归崵鍐煃閸濆嫬鏆為柛鐘冲浮濮?atDepth 婵犵數濮烽弫鎼佸磻閻愬搫鍨傞柣銏犳啞閸嬪鈹戦悩鎻掓殭妞ゆ洟浜堕弻娑樷槈濡吋鎲奸梺?, promptBuild.systemPrompt || "")}
    ${_renderDebugDetails("濠电姷鏁搁崑鐐哄垂閸洖绠板┑鐘崇閸嬪绻濇繝鍌滃闁汇倗鍋撻妵鍕箛閸撲焦鍋ч梺宕囩帛濞茬喖寮婚妸鈺佹婵炲棛鍋撶紞妤呮⒑闁偛鑻晶顕€鏌ㄩ弴銊ょ盎闁伙絽鍢查～婊堝焵椤掆偓閻ｇ兘濡搁埡濠冩櫍閻熸粌绉瑰鏌ユ晲婢跺鎷洪梺鍦焾濞寸兘鍩ユ径鎰厽婵°倓绀佹慨宥夋煙椤栨瑧绐旂€殿喕绮欓、姗€鎮欓幖顓燁棨濠碉紕鍋戦崐鏍箰閸洖绀夐幖杈剧悼閻?, promptBuild.hostInjections)}
    ${_renderDebugDetails("濠电姷鏁搁崑鐐哄垂閸洖绠板┑鐘崇閸嬪绻濇繝鍌滃闁汇倗鍋撻妵鍕箛閸撲焦鍋ч梺宕囩帛濞茬喖寮婚妸鈺佸嵆婵°倐鍋撳ù婊勫劤閳规垿鎮欓悙鍏夊亾鐎ｎ剚宕叉繝闈涙閺嗭箓鏌曟繛鐐珔缂佺媴缍侀弻鐔兼倻濡崵顦ュΔ鐘靛亹閸嬫捇姊绘担钘夊惞濠殿喖纾幏瀣蓟閵夈儳鍔﹀銈嗗坊閸嬫捇鏌涢悢閿嬪仴闁诡喗蓱缁绘繈宕堕妸褍寮虫繝鐢靛仦閸ㄥ爼鈥﹂崶銊︽珷闁挎繂顦伴悡鐔兼煥閺冨倹娅曞褏鏁搁埀顒侇問閸ｎ噣宕滈悢绗衡偓浣割潨閳ь剚淇婂宀婃Ь濡?, promptBuild.hostInjectionPlan || null)}
    ${_renderDebugDetails("濠电姷鏁搁崑鐐哄垂閸洖绠板┑鐘崇閸嬪绻濇繝鍌滃闁汇倗鍋撻妵鍕箛閸撲焦鍋ч梺宕囩帛濞茬喖寮婚妸鈺佸嵆婵ê鍟块崢鈥斥攽閻愯尙澧曢柣鏍с偢楠?, promptBuild.worldInfo?.debug || promptBuild.worldInfoResolution?.debug || null)}
  `;
}

function _renderTaskDebugLlmCard(taskType, llmRequest) {
  if (!llmRequest) {
    return `
      <div class="bme-config-card-title">闂傚倸鍊风粈渚€骞栭锔藉亱闁告劦鍠栫壕濠氭煙閹规劦鍤欑紒鐙欏洦鐓冮柛婵嗗閳ь剚鎮傞幃姗€濡烽埡鍌滃幗闂侀潧鐗嗛幊搴敂椤撶喐鍙忓┑鐘辫兌閻瑧鈧娲忛崝鎴︺€佸Δ鍛＜婵犲﹤瀚弳锝夋⒒閸屾瑧顦﹂柟璇х節閹兘鏁冮崒姘€梻鍌氱墛娓氭宕甸弴鐔翠簻闁圭儤鍨甸鈺呮煛?/div>
      <div class="bme-config-help">闂備浇宕甸崰鎰垝鎼淬垺娅犳俊銈呮噹缁犱即鏌涘☉姗堟敾婵炲懐濞€閺岋絽螣閾忕櫢绱炲銈傛櫇閸忔﹢骞冭ぐ鎺戠倞闁靛鍎崇粊宄邦渻閵堝骸浜栭柛濠冪箓椤曪綁宕奸弴鐐靛幐闂佺顑呴悘姘跺垂閸ф绠氶柍褜鍓熼弻娑樷槈濞嗘劗绋囬柣搴㈣壘椤︻垶鈥︾捄銊﹀磯濞撴凹鍨伴崜杈ㄧ箾鐎电校闁挎洏鍨归锝夊醇閺囩偟鍘搁梺绋挎湰濮樸劍绂掗婊呯＝濞达綀顫夐埛鎰箾閸忚偐鎳囬柛?LLM 闂傚倷娴囧畷鍨叏閺夋嚚娲敇閵忕姷鍝楅梻渚囧墮缁夌敻宕曢幋锔界厵鐎瑰嫭澹嗛悘閬嶆煟閵堝倸浜惧┑锛勫亼閸婃牠宕濋幋锕€纾归柡鍥╁剱閸ゆ洖螖閿濆懎鏆為柣?/div>
    `;
  }

  return `
    <div class="bme-config-card-head">
      <div>
        <div class="bme-config-card-title">闂傚倸鍊风粈渚€骞栭锔藉亱闁告劦鍠栫壕濠氭煙閹规劦鍤欑紒鐙欏洦鐓冮柛婵嗗閳ь剚鎮傞幃姗€濡烽埡鍌滃幗闂侀潧鐗嗛幊搴敂椤撶喐鍙忓┑鐘辫兌閻瑧鈧娲忛崝鎴︺€佸Δ鍛＜婵犲﹤瀚弳锝夋⒒閸屾瑧顦﹂柟璇х節閹兘鏁冮崒姘€梻鍌氱墛娓氭宕甸弴鐔翠簻闁圭儤鍨甸鈺呮煛?/div>
        <div class="bme-config-card-subtitle">
          濠电姷鏁搁崑娑㈩敋椤撶喐鍙忓Δ锝呭枤閺佸鎲告惔銊ョ疄?${_escHtml(taskType)} 闂傚倸鍊风粈渚€骞栭锔藉亱闁告劦鍠栫壕濠氭煙閹规劦鍤欑紒鐙欏洦鐓冮柛婵嗗閳ь剚鎮傞幃姗€鏁愰崶鈺冿紲闂佸搫鍟犻崑鎾寸箾閸忚偐鎳囬柛鈹垮灪閹棃濡搁敂鐑╁亾閹扮増鈷戦柣鎰靛墯閻撱儲銇勯幋婵囧窛闁告帗甯″顕€鍩€椤掑嫬绠柛娑卞灡閸犲棝鏌涢弴銊ュ箻闁哄棎鍨藉娲嚒閵堝憛銏＄箾瀹割喖寮€殿喓鍔戦弻鍡楊吋閸℃澹嬮梻浣筋潐椤旀牠宕伴弴鐐╂煢妞ゅ繐鐗婇悡鏇㈡倶閻愭彃鈷旈柍顖涙礃閵囧嫯鐔侀柛銉ｅ妿閸樹粙姊洪棃娑辩劸闁稿酣浜堕、鏃堝煛閸涱喚鍘介梺闈涚墕閹冲酣顢旈鐔稿弿濠电姳鑳堕惌娆戔偓瑙勬磸閸旀垿銆佸鈧幃娆撴濞戞氨鍘抽梻鍌氬€搁崐椋庢閿熺姴纾婚柛灞惧嚬濞撳鏌熼悜妯诲暗闁崇懓绉撮埞鎴︽偐閸欏鎮欑紓浣哄У鐢濡甸崟顖氬唨闁靛﹤娲﹀畝绋跨暦?
        </div>
      </div>
      <span class="bme-task-pill">${_escHtml(_formatTaskProfileTime(llmRequest.updatedAt))}</span>
    </div>
    <div class="bme-debug-kv-list">
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">闂傚倷娴囧畷鍨叏閺夋嚚娲敇閵忕姷鍝楅梻渚囧墮缁夌敻宕曢幋婢濆綊宕楅崗鑲╃▏缂備胶瀚忛崶銊у帾婵犮垼鍩栫粙鎴︺€呴鍕厽?/span>
        <span class="bme-debug-kv-value">${_escHtml(llmRequest.requestSource || "闂?)}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">闂傚倷娴囧畷鍨叏閺夋嚚娲敇閵忕姷鍝楅梻渚囧墮缁夌敻宕曢幋锔界厵婵炲牆鐏濋弸鐔衡偓瑙勬礀椤︿即濡甸崟顖氬唨闁靛濡囧▓銈囩磽?/span>
        <span class="bme-debug-kv-value">${_escHtml(llmRequest.route || "闂?)}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">婵犵數濮烽。钘壩ｉ崨鏉戝瀭妞ゅ繐鐗嗛悞鍨亜閹哄棗浜剧紒鍓ц檸閸欏啴宕洪埀?/span>
        <span class="bme-debug-kv-value">${_escHtml(llmRequest.model || "闂?)}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">API 闂傚倸鍊搁崐鐑芥倿閿曗偓椤灝螣閼测晝鐓嬮梺鍓插亝濞叉﹢宕戦鍫熺厱闁斥晛鍟伴埥澶岀磼閻欐瑥娲﹂悡蹇擃熆閼哥數鈽夋い鈺婂墴閺?/span>
        <span class="bme-debug-kv-value">${_escHtml(llmRequest.llmConfigSourceLabel || llmRequest.llmConfigSource || "闂?)}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">濠电姷鏁搁崑娑㈩敋椤撶喐鍙忓Δ锝呭枤閺佸鎲告惔銊ョ疄?API 婵犵數濮烽。钘壩ｉ崨鏉戝瀭妞ゅ繐鐗嗙粈鍫熺節闂堟稒锛嶉柣?/span>
        <span class="bme-debug-kv-value">${_escHtml(llmRequest.llmPresetName || (llmRequest.requestedLlmPresetName ? `缂傚倸鍊搁崐鎼佸磹閹间礁纾归柟闂寸缁犺銇勯幇鍓佺暠濡? ${llmRequest.requestedLlmPresetName}` : "闂傚倷娴囧畷鍨叏閹€鏋嶉柨婵嗩槸缁愭鏌″畵顔瑰亾闁哄妫冮弻鏇＄疀閵壯呫偡婵炲瓨绮岀紞濠囧蓟閻旂厧绠氱憸宥夊汲鏉堛劊浜?API"))}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">闂傚倸鍊烽懗鍫曞储瑜旈幃鍧楀炊椤剚鐩畷鐔碱敆娴ｇ浼庨梻濠庡亜濞诧箑顫忕憴鍕洸闁靛牆顦伴悡鏇㈡煏婢舵稓鍒板┑陇妫勯埞鎴︻敊閸濆嫮浠炬繛锝呮搐閿曨亪銆佸☉姗嗘富閻犲洩寮撴竟鏇㈡倵鐟欏嫭绀€婵炲眰鍔戦妴?/span>
        <span class="bme-debug-kv-value">${_escHtml(llmRequest.capabilityMode || "闂?)}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">闂傚倷娴囧畷鍨叏閹绢噮鏁勯柛娑欐綑閻ゎ噣鏌熼幆鏉啃撻柛搴★攻閵囧嫰寮介顫勃闂佹悶鍊曞ú顓烆嚕閸洖閱囨繛鎴灻‖澶娾攽?/span>
        <span class="bme-debug-kv-value">${_escHtml(llmRequest.redacted ? "闂備浇顕у锕傦綖婢舵劖鍋ら柡鍥╁С閻掑﹥銇勮箛鎾跺缂佲偓婢跺鍙忔俊顖涘绾箖鏌? : "闂傚倸鍊风粈渚€骞栭锔藉亱婵犲﹤瀚々鍙夌節闂堟侗鍎愰柛瀣樀閺屻劌鈹戦崱妯侯槱婵?)}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">闂傚倷娴囬褎顨ョ粙鍖¤€块梺顒€绉寸壕濠氭煏閸繃濯奸柣搴ゅ煐閵囧嫰寮介妸褏鐓侀悗瑙勬礀椤︿即濡甸崟顖氬唨闁靛濡囧▓銈囩磽?/span>
        <span class="bme-debug-kv-value">${_escHtml(llmRequest.effectiveRoute?.llm || llmRequest.route || "闂?)}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">闂傚倷绀侀幖顐λ囬鐐村亱濠电姴娲ょ粻浼存煙闂傚顦﹂柛姘愁潐閵囧嫰骞樼捄杞版澀闂侀€炲苯澧悽顖椻偓宕囨殾闁靛ň鏅╅弫濠勭磽娴ｉ潧鐏悮?/span>
        <span class="bme-debug-kv-value">${_escHtml(llmRequest.responseCleaning?.applied ? "闂備浇顕у锕傦綖婢舵劖鍋ら柡鍥╁С閻掑﹥绻涢崱妯诲碍闁哄绶氶弻鐔煎箲閹伴潧娈梺? : "闂傚倸鍊风粈渚€骞栭锔藉亱婵犲﹤瀚々鏌ユ煟閹邦剚鎯堥柡瀣╃窔閺岀喖骞戦幇闈涙闂?)}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">闂傚倸鍊风粈渚€骞夐敓鐘冲仭闁挎洖鍊搁崹鍌炴煕瑜庨〃鍛存倿閸偁浜滈柟杈剧稻绾埖銇勯敂鑲╃暠妞ゎ叀鍎婚ˇ鏉戔攽椤曗偓濞佳団€﹂崶顏嗙杸婵炴垶顭囬鎺楁⒑閸涘﹤濮堢憸鏉垮暙鏁堥柟缁樺坊閺€浠嬫煟閹邦剛鎽犻悘蹇ｅ弮閺岀喖宕橀懠顒傤唺缂?/span>
        <span class="bme-debug-kv-value">${_escHtml(llmRequest.requestCleaning?.applied ? "闂備浇顕у锕傦綖婢舵劖鍋ら柡鍥╁С閻掑﹥绻涢崱妯诲碍闁哄绶氶弻鐔煎箲閹伴潧娈梺? : "闂傚倸鍊风粈渚€骞栭锔藉亱婵犲﹤瀚々鏌ユ煟閹邦剚鎯堥柡瀣╃窔閺岀喖骞戦幇闈涙闂?)}</span>
      </div>
    </div>
    ${_renderDebugDetails("闂傚倸鍊风粈浣革耿鏉堚晛鍨濇い鏍仜缁€澶嬩繆閵堝懏鍣瑰鍛攽椤旂瓔鐒惧鏉戞憸閳ь剚纰嶅銊╁焵椤掆偓缁犲秹宕曢崡鐐嶆稑螖閸涱厾鍘遍梺鍝勫暙閻楀﹪宕戦悩宕囩闁瑰鍊栭幋婵撹€垮ù鐓庣摠閻撴瑩鏌熺紒妯虹闁挎稑绉归弻?, llmRequest.promptExecution || null)}
    ${_renderDebugDetails("闂傚倸鍊风粈渚€骞夐敓鐘冲仭闁挎洖鍊搁崹鍌炴煕瑜庨〃鍛存倿閸偁浜滈柟杈剧稻绾埖銇勯敂鑲╃暠妞ゎ叀鍎婚ˇ鏉戔攽椤曗偓濞佳団€﹂崶顏嗙杸婵炴垶顭囬鎺楁⒑閸涘﹤濮堢憸鏉垮暙鏁堥柟缁樺坊閺€浠嬫煟閹邦剛鎽犻悘蹇ｅ弮閺岀喖宕橀懠顒傤唺缂?, llmRequest.requestCleaning || null)}
    ${_renderDebugDetails("闂傚倷娴囬褎顨ョ粙鍖¤€块梺顒€绉寸壕濠氭煏閸繃濯奸柣搴ゅ煐閵囧嫰寮介妸褏鐓侀柣搴㈢瀹€绋款潖濞差亜鍨傛い鏇炴噹閸撳啿鈹戦悩顐壕闂佸湱铏庨崰妤呭磻閿濆懌鈧帒顫濋悡搴ｄ哗闂佽绻掓慨椋庢?, llmRequest.effectiveRoute || null)}
    ${_renderDebugDetails("闂傚倷绀侀幖顐λ囬鐐村亱濠电姴娲ょ粻浼存煙闂傚顦﹂柛姘愁潐閵囧嫰骞樼捄杞版澀闂侀€炲苯澧悽顖椻偓宕囨殾闁靛ň鏅╅弫濠勭磽娴ｉ潧鐏悮?, llmRequest.responseCleaning || null)}
    ${_renderDebugDetails("API 闂傚倸鍊搁崐鐑芥倿閿曗偓椤灝螣閼测晝鐓嬮梺鍓插亝濞叉﹢宕戦鍫熺厱闁斥晛鍟伴幊鍕煕閻樺弶顥㈤柡灞诲妼閳规垿宕卞鍡橈骏闂?, {
      llmConfigSource: llmRequest.llmConfigSource || "",
      llmConfigSourceLabel: llmRequest.llmConfigSourceLabel || "",
      requestedLlmPresetName: llmRequest.requestedLlmPresetName || "",
      llmPresetName: llmRequest.llmPresetName || "",
      llmPresetFallbackReason: llmRequest.llmPresetFallbackReason || "",
    })}
    ${_renderDebugDetails("闂傚倷娴囬褎顨ョ粙鍖¤€块梺顒€绉寸壕濠氭煏閸繃濯奸柣搴ゅ煐閵囧嫰寮介妸褋鈧帡鏌嶉悷鎵ｇ紒缁樼箞濡啫鈽夊顒夋澑婵犵數鍋涢悧鍡涙儗閸岀偛钃熸繛鎴炃氶弸搴ㄧ叓閸ャ劍灏ㄩ柛瀣崄閵囨劙骞掗幋鐐剁发?, llmRequest.filteredGeneration || {})}
    ${_renderDebugDetails("闂傚倷娴囧畷鐢稿磻閻愬搫绀勭憸鐗堝笒绾捐顭跨捄鐑樻拱鐎规洘鐓￠弻娑㈠箛閻㈤潧甯ラ梺缁樻尪閸庣敻寮婚弴銏犻唶婵犻潧娴傚Λ鐐电磽娴ｈ鈷愰柟鍛婂▕瀵鏁愭径濞⑩晠鏌曟径鍫濆姶濞寸姴銈搁幃妤€鈻撻崹顔界彯闂佸憡鎸鹃崰搴敋?, llmRequest.removedGeneration || [])}
    ${_renderDebugDetails("闂傚倸鍊风粈渚€骞栭锔藉亱闁告劦鍠栫壕濠氭煙閹冾暢缁炬崘妫勯湁闁挎繂鎳忛幉绋款熆瑜庣粙鎾舵閹烘挸绶為悘鐐舵楠炲螖閻橀潧浠掔紒鑸靛哺閵嗕礁鈽夊鍡樺兊濡炪倖甯掗崐椋庡垝閹绢喗鈷?, llmRequest.messages || [])}
    ${_renderDebugDetails("闂傚倸鍊风粈渚€骞栭锔藉亱闁告劦鍠栫壕濠氭煙閹冾暢缁炬崘妫勯湁闁挎繂鎳忛幉绋款熆瑜濈徊楣冨Φ閸曨垰鍗抽柕濞垮劚椤晠鏌℃担鍝ュⅵ闁哄本绋撴禒锕傚礈瑜庨崳顔剧磽?, llmRequest.requestBody || null)}
  `;
}

function _renderTaskDebugInjectionCard(injectionSnapshot) {
  if (!injectionSnapshot) {
    return `
      <div class="bme-config-card-title">闂傚倸鍊风粈渚€骞栭锔藉亱闁告劦鍠栫壕濠氭煙閹规劦鍤欑紒鐙欏洦鐓冮柛婵嗗閳ь剚鎮傞幃姗€鏁冮崒娑氬幐婵炶揪绲介幖顐ｇ鏉堚斁鍋撶憴鍕妞ゃ劌锕ユ穱濠囨偪椤栵絾鞋婵犵數鍋涢ˇ顓㈠垂娴犲钃?/div>
      <div class="bme-config-help">闂傚倷绀侀幖顐λ囬锕€鐤炬繝濠傛閹冲矂姊绘担鍦菇闁稿酣浜堕獮濠偽熸笟顖氭闂佸壊鐓堥崑鍕閻愮儤鍊甸柨婵嗛娴滄绱掗鍛仸闁哄备鍓濆鍕幢濡崵褰嗛梻浣规偠閸斿瞼澹曢鐘插灊闁冲搫鎳庣痪褔鏌熺€涙ɑ鈷愰柣搴☆煼濮婃椽鎮欓挊澶婂闂佸摜鍠曞▔鏇熺閹间礁骞㈡繛鎴炵懅閸橀亶姊洪棃娑崇础闁告剬鍕闂傚倷娴囧銊╂嚄閸洖纾婚柕鍫濇噽閺嗭附淇婇妶鍛櫣閸烆垶姊洪棃娑辨缂佺姵鍨甸妴鎺楀箛閻楀牃鎷虹紓鍌欑劍钃遍悗鍨懃闇夐柨婵嗘缁茶霉?/div>
    `;
  }

  return `
    <div class="bme-config-card-head">
      <div>
        <div class="bme-config-card-title">闂傚倸鍊风粈渚€骞栭锔藉亱闁告劦鍠栫壕濠氭煙閹规劦鍤欑紒鐙欏洦鐓冮柛婵嗗閳ь剚鎮傞幃姗€鏁冮崒娑氬幐婵炶揪绲介幖顐ｇ鏉堚斁鍋撶憴鍕妞ゃ劌锕ユ穱濠囨偪椤栵絾鞋婵犵數鍋涢ˇ顓㈠垂娴犲钃?/div>
        <div class="bme-config-card-subtitle">
          闂傚倷娴囬褏鎹㈤幒妤€纾婚柣鎰梿閸濆嫷鐓ラ柛顐ｆ儕閿旇姤鍙忔俊顖涘绾箖鎮楀顒夋█闁哄苯绉烽¨渚€鏌涢幘纾嬪妞ゎ厼娲︾换婵嗩潩椤掑偆鍚呮繝鐢靛Т閿曘倝骞忕€ｎ偄顕遍柛銉戔偓閺€浠嬫煟閹邦剙绾фい銉﹀灴閺屽秷顧侀柛鎾寸懇瀹曨垳鎹勯妸銈囧墾闂佺硶鍓濈粙鎺楁偂閺囥垺鐓忓璇″灠閸熲晝鍒掗崼鏇熲拺閻犲洠鈧櫕鐏嶅銈冨妼閿曨亪鐛崱娑樼妞ゆ棁鍋愰ˇ鏉款渻閵堝棗绗傞柣鎺炵畱閳绘挸顫滈埀顒€顫忛搹鍦煓閻犳亽鍔庨悿鍕⒑缁嬪灝顒㈤柣鎾偓鎰佸殨闁归棿绀佺粈鍐┿亜閺冨倸甯堕柣婵嚸—鍐Χ閸℃娼戦梺绋款儐閹瑰洭寮婚悢鍏肩叆閻庯綆浜跺Λ鍡涙⒑闁偛鑻晶浼存煙閾忣偅宕屽┑锟犳涧铻ｉ悘蹇旂墪娴滈箖姊婚崼鐔恒€掗柣鎺戞啞椤ㄣ儵鎮欓弻銉ュ及閻庢鍠楅幐鎶藉春濡ゅ懎鐓涘ù锝呭槻椤ユ岸姊绘担鍛婅础闁稿簺鍊濋獮鎰節濮橆厼浜楀┑鐐叉閸ㄧ喖宕戦幘鏂ユ灁闁割煈鍠楅悘鍫㈢磽娴ｇ瓔鍤欓柣妤佹崌瀹曟椽鍩€?
        </div>
      </div>
      <span class="bme-task-pill">${_escHtml(_formatTaskProfileTime(injectionSnapshot.updatedAt))}</span>
    </div>
    <div class="bme-debug-kv-list">
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">闂傚倸鍊风粈渚€骞栭位鍥敇閵忕姷锛熼梺鑲┾拡閸撴繃鎱?/span>
        <span class="bme-debug-kv-value">${_escHtml(injectionSnapshot.sourceLabel || injectionSnapshot.source || "闂?)}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">闂傚倷娴囧畷鐢稿窗閹扮増鍋￠弶鍫氭櫇娑撳秹鏌熸潏鍓хシ濞存粌缍婇弻娑樼暆閳ь剟宕戦悙鐑樺亗闁靛繈鍊栭悡鍐级閻愭潙顎滈柛蹇撶焸閺?/span>
        <span class="bme-debug-kv-value">${_escHtml(injectionSnapshot.hookName || "闂?)}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">闂傚倸鍊搁崐椋庢閿熺姴纾婚柛鏇ㄥ瀬閸ヮ剦鏁嬮柍褜鍓熼獮濠傗枎閹惧磭顓洪梺鎸庢濡嫬鈻撻悢鍏尖拺缂佸瀵у﹢鎵磼椤斿吋婀扮紒鍌涘浮椤㈡盯鎮欑€电骞?/span>
        <span class="bme-debug-kv-value">${_escHtml(String(injectionSnapshot.selectedNodeIds?.length ?? 0))}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">闂傚倷娴囬褍霉閻戣棄绠犻柟鎹愵嚙妗呭┑鈽嗗灠閻ㄧ兘宕戦幘缁橆棃婵炴垶姘ㄩ崝顖毼旈悩闈涗粶闂佸府绲介锝夊箻椤旇偐鍘梺瀹犳〃濡炴帗绔?/span>
        <span class="bme-debug-kv-value">${_escHtml(injectionSnapshot.transport?.source || "闂?)} / ${_escHtml(injectionSnapshot.transport?.mode || "闂?)}</span>
      </div>
    </div>
    ${_renderDebugDetails("闂傚倸鍊风粈渚€骞夐敓鐘冲仭妞ゆ牜鍋涚粈鍫熺箾閸℃璐╂繛宸簻閸愨偓濡炪倖鍔戦崐妤呮晬濠婂牊鈷戠紓浣股戦埛鎰繆閻愬弶鍋ョ€规洏鍎甸崺鈧?, {
      retrievalMeta: injectionSnapshot.retrievalMeta || {},
      llmMeta: injectionSnapshot.llmMeta || {},
      stats: injectionSnapshot.stats || {},
      transport: injectionSnapshot.transport || {},
    })}
    ${_renderDebugDetails("闂傚倸鍊风粈渚€骞栭锔藉亱闁告劦鍠栫壕濠氭煙閹冾暢缁炬崘妫勯湁闁挎繂鎳忛幉绋款熆瑜庨惄顖炲蓟閳╁啯濯撮柛婵嗗濡叉劙鎮楃憴鍕妞ゃ劌锕ユ穱濠囨倻閼恒儲娅嗛梺浼欑到婢跺洭宕戦幘娲绘晪闁逞屽墴瀵?, injectionSnapshot.injectionText || "")}
  `;
}

function _renderDebugDetails(title, value) {
  const isEmptyArray = Array.isArray(value) && value.length === 0;
  const isEmptyObject =
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0;
  const isEmpty = value == null || value === "" || isEmptyArray || isEmptyObject;

  return `
    <details class="bme-debug-details" ${isEmpty ? "" : "open"}>
      <summary>${_escHtml(title)}</summary>
      ${
        isEmpty
          ? '<div class="bme-debug-empty">闂傚倸鍊风粈渚€骞栭鈶芥稑螖閸涱厾锛欓梺鑽ゅ枑鐎氬牆鈽夐姀鐘栄冾熆鐠虹尨鍔熸い锔哄姂濮婃椽宕ㄦ繝浣虹箒闂佸憡鐟ラ柊锝呯暦?/div>'
          : `<pre class="bme-debug-pre">${_escHtml(_stringifyDebugValue(value))}</pre>`
      }
    </details>
  `;
}

function _stringifyDebugValue(value) {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function _getBlockTypeIcon(type) {
  switch (type) {
    case "builtin": return `<i class="fa-solid fa-thumbtack"></i>`;
    case "legacyPrompt": return `<i class="fa-solid fa-scroll"></i>`;
    default: return `<i class="fa-regular fa-file-lines"></i>`;
  }
}

function _getInjectModeLabel(mode) {
  switch (mode) {
    case "append": return "闂傚倷绀侀幖顐λ囬锕€鐤鹃柣鎰棘濞戙垹绀嬫い鎺嶇瀵?;
    case "relative":
    default: return "闂傚倸鍊烽懗鍫曞磿閻㈢鐤炬繝闈涱儌閳ь剨绠撳畷濂稿Ψ椤旇姤娅?;
  }
}

function _renderTaskBlockRow(block, index, state) {
  const isExpanded = block.id === state.selectedBlock?.id;
  const roleClass = `bme-badge-role-${block.role || "system"}`;
  const disabledClass = block.enabled ? "" : "is-disabled";
  const expandedClass = isExpanded ? "is-expanded" : "";

  return `
    <div
      class="bme-task-block-row ${disabledClass} ${expandedClass}"
      data-block-id="${_escAttr(block.id)}"
    >
      <div class="bme-task-block-row-header" data-task-action="toggle-block-expand" data-block-id="${_escAttr(block.id)}">
        <span
          class="bme-task-drag-handle"
          title="闂傚倸鍊风粈浣虹礊婵犲洤缁╅梺顒€绉甸崑瀣繆閵堝懎鏆婇柛瀣尭椤繈顢楁担闀愭樊婵°倗濮烽崑鐐垫暜閿熺姷宓侀柟鐑橆殔缁狅綁鏌ｅΟ娲诲晱闁?
          aria-label="闂傚倸鍊风粈浣虹礊婵犲洤缁╅梺顒€绉甸崑瀣繆閵堝懎鏆婇柛瀣尭椤繈顢楁担闀愭樊婵°倗濮烽崑鐐垫暜閿熺姷宓侀柟鐑橆殔缁狅綁鏌ｅΟ娲诲晱闁?
          draggable="true"
        >
          <i class="fa-solid fa-grip-vertical"></i>
        </span>
        <span class="bme-task-block-icon">
          ${_getBlockTypeIcon(block.type)}
        </span>
        <span class="bme-task-block-name">
          ${_escHtml(block.name || _getTaskBlockTypeLabel(block.type))}
        </span>
        <span class="bme-task-block-badge ${roleClass}">
          ${_escHtml(block.role || "system")}
        </span>
        <span class="bme-task-block-badge">
          ${_escHtml(_getInjectModeLabel(block.injectionMode))}
        </span>
        <span class="bme-task-block-row-spacer"></span>
        <button
          class="bme-task-row-btn"
          data-task-action="toggle-block-expand"
          data-block-id="${_escAttr(block.id)}"
          type="button"
          title="缂傚倸鍊搁崐鎼佸磹閹间礁纾圭憸鐗堝笚閸嬪鏌ｉ幇顒備粵妞?
        >
          <i class="fa-solid fa-pen"></i>
        </button>
        <button
          class="bme-task-row-btn bme-task-row-btn-danger"
          data-task-action="delete-block"
          data-block-id="${_escAttr(block.id)}"
          type="button"
          title="闂傚倸鍊风粈渚€骞夐敍鍕殰闁绘劕顕粻楣冩煃瑜滈崜姘辨崲?
        >
          <i class="fa-solid fa-xmark"></i>
        </button>
        <label class="bme-task-row-toggle" title="${block.enabled ? "闂備浇顕уù鐑藉箠閹捐绠熼梽鍥Φ閹版澘绀冩い鏃囧亹閻ｉ箖鏌熼崗鑲╂殬闁告柨绉瑰畷? : "闂備浇顕уù鐑藉箠閹捐绠熼梽鍥Φ閹版澘绀冮柍鍝勫枤濞村嫰姊虹紒姗嗙劷缂侇噮鍨跺畷?}">
          <input
            type="checkbox"
            data-task-action="toggle-block-enabled-cb"
            data-block-id="${_escAttr(block.id)}"
            ${block.enabled ? "checked" : ""}
          />
          <span class="bme-task-row-toggle-slider"></span>
        </label>
      </div>
      ${isExpanded ? `
        <div class="bme-task-block-expand">
          ${_renderTaskBlockInlineEditor(block, state)}
        </div>
      ` : ""}
    </div>
  `;
}

function _renderTaskBlockInlineEditor(block, state) {
  const builtinOptions = state.builtinBlockDefinitions
    .map(
      (item) => `
        <option
          value="${_escAttr(item.sourceKey)}"
          ${item.sourceKey === block.sourceKey ? "selected" : ""}
        >
          ${_escHtml(item.name)}
        </option>
      `,
    )
    .join("");
  const legacyField = getLegacyPromptFieldForTask(state.taskType);
  const legacyValue =
    legacyField && block.type === "legacyPrompt"
      ? state.settings?.[legacyField] || block.content || getDefaultPromptText(state.taskType) || ""
      : block.content || "";

  return `
    <div class="bme-config-row">
      <label>闂傚倸鍊烽懗鍫曪綖鐎ｎ喖绀嬮柛顭戝亞閺嗐儵姊绘担绛嬪殐闁哥姵顨呯叅婵犲﹤鎳庨崹?/label>
      <input
        class="bme-config-input"
        type="text"
        data-block-field="name"
        value="${_escAttr(block.name || "")}"
        placeholder="闂傚倸鍊烽悞锕€顪冮崹顕呯劷闁秆勵殔缁€澶愭倵閿濆骸澧插┑顔挎珪閵囧嫰骞掗崱妞惧婵＄偑鍊栭弻銊ф崲濡绻嗛柣鎴ｆ鍥撮梺鎼炲劗閺備線寮稿▎鎾粹拻濞达絽鎲￠崯鐐烘煟濡や胶鐭掔€规洘娲熸俊鍫曞川閸屾粌鏋戠€垫澘瀚悾婵嬪焵椤掑嫭鍎?
      />
    </div>

    <div class="bme-task-expand-row2">
      <div class="bme-config-row">
        <label>闂傚倷娴囧畷鐢稿窗閹扮増鍋￠柨鏃傚亾閺嗘粓鏌ｉ弬鎸庢喐闁?/label>
        <select class="bme-config-input" data-block-field="role">
          ${TASK_PROFILE_ROLE_OPTIONS.map(
            (item) => `
              <option value="${item.value}" ${item.value === block.role ? "selected" : ""}>
                ${item.label}
              </option>
            `,
          ).join("")}
        </select>
      </div>
      <div class="bme-config-row">
        <label>婵犵數濮烽弫鎼佸磻濞戔懞鍥敇閵忕姷顦悗鍏夊亾闁告洦鍋嗛悡鎴︽⒑缁洖澧茬紒瀣灥铻炴慨妞诲亾闁哄矉缍侀幃銏㈢矙濞嗙偓顥嬬紓浣鸿檸閸樻悂宕?/label>
        <select class="bme-config-input" data-block-field="injectionMode">
          ${TASK_PROFILE_INJECTION_OPTIONS.map(
            (item) => `
              <option
                value="${item.value}"
                ${item.value === (block.injectionMode || "append") ? "selected" : ""}
              >
                ${item.label}
              </option>
            `,
          ).join("")}
        </select>
      </div>
    </div>

    ${
      block.type === "builtin"
        ? (() => {
            const externalSourceMap = {
              charDescription: "闂傚倷娴囧畷鐢稿窗閹扮増鍋￠柨鏃傚亾閺嗘粓鏌ｉ弬鎸庢喐闁绘繆娉涢埞鎴︽偐閸欏鎮欑紒缁㈠幐閸嬫捇姊绘担瑙勭伇闁哄懏鐩畷顖烆敃閿濆拋鍤ら柟鍏肩暘閸斿瞼鐥?,
              userPersona: "闂傚倸鍊烽悞锕€顪冮崹顕呯劷闁秆勵殔缁€澶屸偓骞垮劚椤︻垶寮?Persona 闂傚倷娴囧畷鍨叏閹惰姤鍊块柨鏇炲€哥壕鍧楁煙閹澘袚闁?,
              worldInfoBefore: "World Info (闂?Char)",
              worldInfoAfter: "World Info (闂?Char)",
            };
            const externalLabel = externalSourceMap[block.sourceKey];
            return `
            <div class="bme-config-row">
              <label>闂傚倸鍊风粈渚€骞夐敓鐘茬闁哄洢鍨圭粻鐘绘煙閹殿喖顣奸柛瀣典邯閺屾盯鍩勯崘顏佹缂備胶瀚忛崶銊у帾婵犮垼鍩栫粙鎴︺€呴鍕厽?{_helpTip("闂傚倷绀侀幖顐λ囬锕€鐤炬繝濠傜墕缁€澶嬫叏濡炶浜鹃梺闈涙缁舵岸鐛€ｎ喗鏅濋柍褜鍓涢悮鎯ь吋婢跺鍘靛銈嗙墬缁嬫帞娆㈤崣澶岀闁割偅绮屽畵鍡涙煛鐏炲墽娲寸€殿噮鍓涢幏鐘诲箵閹烘繄鈧京绱撻崒娆戣窗闁哥姵纰嶉幈銊╂偨閻㈢數鐒块梺鍦劋濮婂湱鈧碍宀搁弻鐔虹磼濡桨鍒婂┑鐐跺濞呮洜鎹㈠☉銏犵闁绘劖娼欑喊宥夋⒑閹稿孩绌跨紒鑼舵硶閸掓帡顢橀姀鐘茬獩闂佸搫顦伴崹鍫曀夊┑瀣拺闁硅偐鍋涢崝姗€鏌涢弬璺ㄐх€殿喗濞婂畷濂稿Ψ閿旀儳骞堥梻濠庡亜濞层倝顢栭崨鏉戠闁靛牆妫涚粻楣冩煕椤愩倕鏋庨柣蹇擃嚟閳ь剚顔栭崳顕€宕戞繝鍥х畺鐟滄柨鐣烽悡搴樻斀闁割偅绋戞禍浼存⒒?)}</label>
              <select class="bme-config-input" data-block-field="sourceKey">
                ${builtinOptions}
              </select>
            </div>
            ${externalLabel
              ? `<div class="bme-task-note" style="text-align:center;padding:0.75rem;opacity:0.7;">
                   闂傚倸鍊风粈渚€骞夐敓鐘茬闁哄洢鍨圭粻鐘诲箹閹碱厾鍘涢柡浣革躬閺岀喖鎮ч崼鐔哄嚒缂備胶瀚忛崶銊у帾婵犮垼鍩栫粙鎴︺€呴鍕厽闁哄稁鍘洪幉楣冩煛?strong>${externalLabel}</strong>闂傚倸鍊烽悞锔锯偓绗涘懐鐭欓柟杈剧畱鐎氬銇勯幒鍡椾壕闁捐崵鍋ら弻鏇㈠醇濠靛洤娅濋梺鍝勵儐閻楃娀寮婚敓鐘茬倞闁宠桨妞掑▽顏堟⒒婵犲骸澧婚柛鎾村哺楠炲牓濡搁妷銏℃杸闂佸憡娲﹂崑鈧柛瀣尭铻栭柛鎰ㄦ櫓濞肩喎顪冮妶鍛闁瑰啿绻掔槐鐐哄炊椤掍胶鍘甸柣搴㈢⊕椤洭骞夐崸妤佺厱?
                 </div>`
              : `<div class="bme-config-row">
                   <label>闂傚倷娴囧畷鐢稿窗閹邦優娲冀椤剚绋戦埥澶娢熻箛鏇炲妺缂佺粯绻堝畷鎯邦槾妞わ负鍔戝娲川婵犱胶绻侀梺鍛婄懃闁帮絽鐣烽鐐茬倞妞ゆ帊鑳堕崣鍡椻攽閻愭潙鐏︽い顓炴处閺呭爼寮撮悩鍐叉瀾闂佺粯顨呴悧蹇涘矗閳ь剟姊洪崫鍕闁瑰啿绻愰銉╁礋椤愮喐顫嶅┑顔斤耿绾危?{_helpTip("闂傚倸鍊峰鎺旀椤旀儳绶ゅΔ锝呭暞閸嬶紕鎲搁弮鍫濇槬闁绘劕鎼崘鈧銈嗘尵閸嬬喖鎯堥崟顖涒拺閻犲洠鈧磭浠┑鐘灪閿氶柍缁樻尰鐎佃偐鈧稒顭囬崢閬嶆⒑閸濆嫬鈧粙顢氳娣囧﹪鎼归崷顓狅紲?sourceKey 闂傚倷娴囬褍霉閻戣棄鏋侀柟闂寸缁犵娀鏌熼悙顒€鍔跺┑顔藉▕閺岋紕浠︾拠鎻掑闂佺楠哥粔褰掑蓟濞戙垹鍗抽柕濞垮€楅弫鏍⒑閼姐倕鏋戦柛鏃€娲熼崺銉﹀緞閹邦剛顔掗梺褰掝暒缁€渚€宕滈柆宥嗏拺闁告繂瀚烽崕蹇涙煕閻斿憡缍戞い鏇秮椤㈡洟鏁傞挊澶夌綍闂備礁澹婇崑鍛崲閸曨垰围闁挎洖鍊归悡鐔兼煟濡搫绾х紒灞惧閵囧嫰寮撮崱妤侇棑濞存粌缍婇弻娑㈠Ψ椤旂厧顫╅弶?)}</label>
                   <textarea
                     class="bme-config-textarea"
                     data-block-field="content"
                     placeholder="闂傚倸鍊峰鎺旀椤旀儳绶ゅΔ锝呭暞閸嬶紕鎲搁弮鍫濇槬闁绘劕鎼崘鈧銈嗘尵閸嬬喖鎯堥崟顖涒拺闁告繂瀚晶銏ゆ煛娴ｈ鍊愰柟?sourceKey 闂傚倷娴囬褍霉閻戣棄鏋侀柟闂寸缁犵娀鏌熼悙顒€鍔跺┑顔藉▕閺岋紕浠︾拠鎻掑闂佺楠哥粔褰掑蓟濞戙垹鍗抽柕濞垮€楅崙褰掓倵鐟欏嫭绀冮柣鎿勭節瀵鈽夐姀鐘愁棟闁荤偞绋堥埀顒€鍘栨竟鏇㈡⒑閼测斁鎷￠柛鎾寸洴楠炲顢旈崨顖滎啎闂佺懓顕崑鐐典焊椤撶喆浜滈柟瀛樼箖椤ャ垻鈧鍠楅幃鍌氱暦濮椻偓椤㈡棃宕ㄩ鐘查叡闂備浇宕垫慨鏉懨洪敃浣典汗闁告劦浜滅欢銈夋煕瑜庨〃鍡涙偂?
                   >${_escHtml(block.content || "")}</textarea>
                 </div>`
            }`;
          })()
        : block.type === "legacyPrompt"
          ? `
              <div class="bme-task-note">
                闂備浇宕甸崰鎰垝鎼淬垺娅犳俊銈呮噹缁犱即鏌涘☉姗堟敾婵炲懐濞€閺岋絽螣濞嗘儳娈梻浣斤骏閸婃牗绌辨繝鍥ㄥ€烽柟缁樺坊閹稿啴姊洪懡銈呮瀭闁搞劋绮欏濠氭晸閻樿尙顦ㄩ梺鍛婃处閸嬪懘宕崇憴鍕╀簻?prompt 闂傚倷娴囬褏鈧稈鏅濈划娆撳箳濡炲皷鍋撻崘顔煎耿婵炴垼椴搁弲鈺呮煟韫囨洖浠滃褌绮欓崺鐐差吋閸℃瑧鐦堥梻鍌氱墛缁嬫帡骞栭幇鐗堢厽闁挎棁顕у▍宥夋煛鐏炲墽顬肩紒鐘崇洴瀵挳鎮欓煫顓犲笡濠碉紕鍋戦崐鏍ь潖瑜版帒绀夋繛鍡樺姃缁诲棝鏌熺紒銏犳灈缁炬儳鍚嬬换婵囩節閸屾凹浠鹃梺浼欑秵閸撴稓妲愰幘瀛樺闁告縿鍎虫导鍥⒑缁嬭法鏄傞柛濠冩礋閳ユ棃宕橀鑲╋紲濠电偞鍨堕悷銈咁潩閿曞倹鈷戠憸鐗堝笒娴滀即鏌涢妸銉ｅ仮鐎殿喓鍔嶇粋鎺斺偓锝庡亞閸樻悂姊洪崨濠傚闁哄懏绮撳鎼佸礋椤撶姷锛滈梺鍛婄懄閿氱€规挸妫涢埀顒冾潐濞叉牠鎮ユ總绋跨畺婵炲棙鍨堕崑姗€鏌嶉妷銉ュ笭濠㈣娲熷娲焻閻愯尪瀚板褍顕埀顒冾潐濞叉ê鐣濈粙娆惧殨闁割偅娲栭崹鍌涖亜閺冨洤袚婵炲牏鏅槐鎾诲磼濮橆兘鍋撻幖浣哥獥婵娉涢梻顖炴煥濠靛棙鎼愰柛銊︾箖閵囧嫰寮介妸褏鐓佹繝?prompt闂?
              </div>
              <div class="bme-config-row">
                <label>闂傚倸鍊烽懗鍫曗€﹂崼銏″床闁圭儤顨呴崒銊ф喐閺冨牄鈧礁鈻庨幘宕囩杸濡炪倖姊婚幊鎾寸閻愵剛绠鹃柟瀵稿仧閹虫劖绻涢崼鐔哥闁?/label>
                <input class="bme-config-input" type="text" value="${_escAttr(legacyField || block.sourceField || "")}" readonly />
              </div>
              <div class="bme-config-row">
                <label>闂傚倸鍊烽懗鍫曗€﹂崼銏″床闁圭儤顨呴崒銊ф喐閺冨牄鈧?prompt 闂傚倸鍊风粈渚€骞夐敓鐘茬闁哄洢鍨圭粻鐘诲箹閹碱厾鍘涢柡?/label>
                <textarea
                  class="bme-config-textarea"
                  data-block-field="content"
                  placeholder="闂傚倸鍊峰鎺旀椤旀儳绶ゅΔ锝呭暞閸嬶紕鎲搁弮鍫濇槬?= 缂傚倸鍊搁崐鎼佸磹妞嬪海绀婇柍褜鍓熼弻娑樷槈閸楃偟浠梺鍝勬婢ф鎹㈠☉娆愮秶闁告挆鍛呮艾鈹戦悙宸Ч婵炶尙鍠庨锝夘敃閿曗偓鍥存繝銏ｆ硾閿曪箓藝閵娾晜鈷戦柛娑橈梗缁堕亶鏌涢妸锕€鈻曠€殿喗鎮傚畷鎺戭潩閸忕厧浠存繝鐢靛仦閸ㄥ爼鎮烽鐐村€块柣鎰靛厵娴?prompt"
                >${_escHtml(legacyValue)}</textarea>
              </div>
            `
          : `
              <div class="bme-config-row">
                <label>闂傚倸鍊烽懗鍫曪綖鐎ｎ喖绀嬮柛顭戝亞閺嗐儵姊绘担鍛婃喐闁稿鐩、姘额敇閵忕姷鍔?/label>
                <textarea
                  class="bme-config-textarea"
                  data-block-field="content"
                  placeholder="闂傚倸鍊峰ù鍥Υ閳ь剟鏌涚€ｎ偅灏伴柕鍥у瀵粙濡歌濡插牓姊?{{userMessage}} / {{recentMessages}} / {{schema}} 缂傚倸鍊搁崐鐑芥倿閿斿墽鐭欓柟娆¤娲幖褰掝敃閵堝孩閿ら梻渚€娼ч悧鍡浰囨导瀛樺亗闁稿瞼鍋熼崣鎾绘煕閵夛絽濡介悘蹇ｅ幘缁辨挸顓奸崟顓犵崲濠殿喖锕ュ浠嬬嵁閹捐绠抽柡鍐ㄥ€婚弶浠嬫⒒?
                >${_escHtml(block.content || "")}</textarea>
              </div>
            `
    }

    <div class="bme-task-expand-footer">
      <button class="bme-config-secondary-btn" data-task-action="toggle-block-expand" data-block-id="${_escAttr(block.id)}" type="button">
        <i class="fa-solid fa-chevron-up"></i> 闂傚倸鍊峰ù鍥Υ閳ь剟鏌涚€ｎ偅宕岄柡宀€鍠栭、娑橆煥閸愮偓姣夐柣?
      </button>
    </div>
  `;
}

function _renderGenerationField(field, value, state = {}) {
  const effectiveValue = (value != null && value !== "") ? value : field.defaultValue;

  if (field.type === "llm_preset") {
    const presetMap =
      state?.settings && typeof state.settings === "object"
        ? state.settings.llmPresets || {}
        : {};
    const presetNames = Object.keys(presetMap).sort((left, right) =>
      left.localeCompare(right, "zh-Hans-CN"),
    );
    const currentValue = String(effectiveValue || "");
    const hasCurrentPreset =
      !currentValue || presetNames.includes(currentValue);
    const currentLabel = !currentValue
      ? "闂傚倷娴囧畷鍨叏閹€鏋嶉柨婵嗩槸缁愭鏌″畵顔瑰亾闁哄妫冮弻鏇＄疀閵壯呫偡婵炲瓨绮岀紞濠囧蓟閻旂厧绠氱憸宥夊汲鏉堛劊浜?API"
      : hasCurrentPreset
        ? currentValue
        : `${currentValue}闂傚倸鍊烽悞锔锯偓绗涘懐鐭欓柟杈鹃檮閸嬪鏌涢埄鍐槈缂佲偓閸曨垱鐓冮柍杞扮閺嗙喖鏌嶇紒妯活棃闁哄本娲濈粻娑㈠即閻愭劗鍋涢湁婵犲﹤鍟ㄩ崑銏ゆ煛鐏炶濡奸柍钘夘槸铻ｉ柛顭戝櫘娴煎啴姊绘担鍦菇闁告柨锕畷褰掓寠婢跺本娈鹃梺鍓插亝濞叉﹢宕愰悜鑺ュ仩婵炴垶宸婚崑鎾诲礂閸涱収妫滈梻鍌欑窔閳ь剛鍋涢懟顖涙櫠閺屻儲鐓忛柛銉ｅ妼婵秵顨ラ悙杈捐€跨€规洘锚椤斿繘顢欓悾灞稿亾?API闂傚倸鍊烽悞锔锯偓绗涘懐鐭欓柟杈剧稻椤?
    const options = [
      {
        value: "",
        label: "闂傚倷娴囧畷鍨叏閹€鏋嶉柨婵嗩槸缁愭鏌″畵顔瑰亾闁哄妫冮弻鏇＄疀閵壯呫偡婵炲瓨绮岀紞濠囧蓟閻旂厧绠氱憸宥夊汲鏉堛劊浜?API",
      },
      ...(!currentValue || hasCurrentPreset
        ? []
        : [{ value: currentValue, label: currentLabel }]),
      ...presetNames.map((name) => ({
        value: name,
        label: name,
      })),
    ];

    return `
      <div class="bme-config-row">
        <label>${_escHtml(field.label)}</label>
        <select
          class="bme-config-input"
          data-generation-key="${_escAttr(field.key)}"
          data-value-type="text"
        >
          ${options
            .map(
              (item) => `
                <option value="${_escAttr(item.value)}" ${item.value === currentValue ? "selected" : ""}>
                  ${_escHtml(item.label)}
                </option>
              `,
            )
            .join("")}
        </select>
        ${field.help ? `<div class="bme-config-help">${_escHtml(field.help)}</div>` : ""}
      </div>
    `;
  }

  if (field.type === "tri_bool") {
    const currentValue =
      effectiveValue === true ? "true" : effectiveValue === false ? "false" : "";
    return `
      <div class="bme-config-row">
        <label>${_escHtml(field.label)}</label>
        <select
          class="bme-config-input"
          data-generation-key="${_escAttr(field.key)}"
          data-value-type="tri_bool"
        >
          ${TASK_PROFILE_BOOLEAN_OPTIONS.map(
            (item) => `
              <option value="${item.value}" ${item.value === currentValue ? "selected" : ""}>
                ${item.label}
              </option>
            `,
          ).join("")}
        </select>
      </div>
    `;
  }

  if (field.type === "enum") {
    return `
      <div class="bme-config-row">
        <label>${_escHtml(field.label)}</label>
        <select
          class="bme-config-input"
          data-generation-key="${_escAttr(field.key)}"
          data-value-type="text"
        >
          ${(field.options || [])
            .map(
              (item) => `
                <option value="${_escAttr(item.value)}" ${item.value === String(effectiveValue ?? "") ? "selected" : ""}>
                  ${_escHtml(item.label)}
                </option>
              `,
            )
            .join("")}
        </select>
      </div>
    `;
  }

  if (field.type === "range") {
    const numValue = effectiveValue != null && effectiveValue !== "" ? Number(effectiveValue) : "";
    const displayValue = numValue !== "" ? numValue : field.min ?? 0;
    return `
      <div class="bme-config-row">
        <label>${_escHtml(field.label)} <span class="bme-range-value">${numValue !== "" ? numValue : "濠电姵顔栭崰妤冩暜濡ゅ啰鐭欓柟鐑樸仜閳ь剨绠撳畷濂稿Ψ椤旇姤娅?}</span></label>
        <div class="bme-range-group">
          <input
            class="bme-range-input"
            type="range"
            min="${field.min ?? 0}"
            max="${field.max ?? 1}"
            step="${field.step ?? 0.01}"
            value="${displayValue}"
            data-generation-key="${_escAttr(field.key)}"
            data-value-type="number"
          />
          <input
            class="bme-config-input bme-range-number"
            type="number"
            min="${field.min ?? 0}"
            max="${field.max ?? 1}"
            step="${field.step ?? 0.01}"
            value="${_escAttr(numValue)}"
            placeholder="濠电姵顔栭崰妤冩暜濡ゅ啰鐭欓柟鐑樸仜閳ь剨绠撳畷濂稿Ψ椤旇姤娅?
            data-generation-key="${_escAttr(field.key)}"
            data-value-type="number"
          />
        </div>
      </div>
    `;
  }

  return `
    <div class="bme-config-row">
      <label>${_escHtml(field.label)}</label>
      <input
        class="bme-config-input"
        type="${field.type === "text" ? "text" : "number"}"
        ${field.step ? `step="${field.step}"` : ""}
        value="${_escAttr(effectiveValue ?? "")}"
        placeholder="闂傚倸鍊峰鎺旀椤旀儳绶ゅΔ锝呭暞閸嬶紕鎲搁弮鍫濇槬?= 闂傚倷娴囧畷鍨叏閹€鏋嶉柨婵嗩槸缁愭鏌″畵顔瑰亾闁哄妫冮弻鏇＄疀婵犲喚娼戝┑鐐存崄閸╂牗绌辨繝鍥舵晬婵炴垵宕崝宀勬⒑?
        data-generation-key="${_escAttr(field.key)}"
        data-value-type="${field.type === "text" ? "text" : "number"}"
      />
    </div>
  `;
}

function _formatRegexRulePreview(findRegex = "") {
  const collapsed = String(findRegex || "")
    .replace(/\s+/g, " ")
    .trim();
  return collapsed || "(闂傚倸鍊风粈渚€骞栭锔藉亱婵犲﹤瀚々鍙夌節婵犲倻澧涢柡鍛叀閺岋綁骞囬浣瑰創缂備讲鍋?find_regex)";
}

function _renderRegexRuleRow(rule, index, state, options = {}) {
  const isExpanded = rule.id === state.selectedRule?.id;
  const deleteAction = options.deleteAction || "delete-regex-rule";
  const defaultNamePrefix = options.defaultNamePrefix || "闂傚倸鍊风粈渚€骞栭锔藉亱婵犲﹤鐗嗙粈鍫熺箾閸℃鐛滈柤鏉挎健閹妫冨☉娆忔殘闂佸摜濮村Λ婵嬪蓟濞戙垹鍗抽柕濞垮劙缁ㄥ姊?;
  const statusLabel = rule.enabled ? "闂傚倸鍊风粈渚€骞夐敓鐘茬鐟滅増甯掗崹鍌炴煙閹増顥夐柡? : "闂傚倸鍊烽懗鍫曗€﹂崼銉晞闁糕剝鐟ラ崹婵嬪箹濞ｎ剙濡奸柡?;
  const previewText = _formatRegexRulePreview(rule.find_regex);

  return `
    <div
      class="bme-regex-rule-row ${isExpanded ? "is-expanded" : ""} ${rule.enabled ? "" : "is-disabled"}"
      data-rule-id="${_escAttr(rule.id)}"
    >
      <div
        class="bme-regex-rule-row-header"
        data-task-action="toggle-regex-rule-expand"
        data-rule-id="${_escAttr(rule.id)}"
      >
        <span
          class="bme-task-drag-handle bme-regex-drag-handle"
          title="闂傚倸鍊风粈浣虹礊婵犲洤缁╅梺顒€绉甸崑瀣繆閵堝懎鏆婇柛瀣尭椤繈顢楁担闀愭樊婵°倗濮烽崑鐐垫暜閿熺姷宓侀柟鐑橆殔缁狅綁鏌ｅΟ娲诲晱闁?
          aria-label="闂傚倸鍊风粈浣虹礊婵犲洤缁╅梺顒€绉甸崑瀣繆閵堝懎鏆婇柛瀣尭椤繈顢楁担闀愭樊婵°倗濮烽崑鐐垫暜閿熺姷宓侀柟鐑橆殔缁狅綁鏌ｅΟ娲诲晱闁?
          draggable="true"
        >
          <i class="fa-solid fa-grip-vertical"></i>
        </span>
        <span class="bme-regex-rule-name">
          ${_escHtml(rule.script_name || `${defaultNamePrefix} ${index + 1}`)}
        </span>
        <span class="bme-regex-rule-status ${rule.enabled ? "is-enabled" : "is-disabled"}">
          ${_escHtml(statusLabel)}
        </span>
        <span class="bme-regex-rule-preview" title="${_escAttr(previewText)}">
          ${_escHtml(previewText)}
        </span>
        <button
          class="bme-task-row-btn"
          data-task-action="toggle-regex-rule-expand"
          data-rule-id="${_escAttr(rule.id)}"
          type="button"
          title="缂傚倸鍊搁崐鎼佸磹閹间礁纾圭憸鐗堝笚閸嬪鏌ｉ幇顒備粵妞?
        >
          <i class="fa-solid fa-pen"></i>
        </button>
        <button
          class="bme-task-row-btn bme-task-row-btn-danger"
          data-task-action="${_escAttr(deleteAction)}"
          data-rule-id="${_escAttr(rule.id)}"
          type="button"
          title="闂傚倸鍊风粈渚€骞夐敍鍕殰闁绘劕顕粻楣冩煃瑜滈崜姘辨崲?
        >
          <i class="fa-solid fa-xmark"></i>
        </button>
        <label class="bme-task-row-toggle" title="${rule.enabled ? "闂備浇顕уù鐑藉箠閹捐绠熼梽鍥Φ閹版澘绀冩い鏃囧亹閻ｉ箖鏌熼崗鑲╂殬闁告柨绉瑰畷? : "闂備浇顕уù鐑藉箠閹捐绠熼梽鍥Φ閹版澘绀冮柍鍝勫枤濞村嫰姊虹紒姗嗙劷缂侇噮鍨跺畷?}">
          <input
            type="checkbox"
            data-regex-rule-row-enabled="true"
            data-rule-id="${_escAttr(rule.id)}"
            ${rule.enabled ? "checked" : ""}
          />
          <span class="bme-task-row-toggle-slider"></span>
        </label>
      </div>
      ${isExpanded
        ? `
            <div class="bme-regex-rule-expand">
              ${_renderRegexRuleInlineEditor(rule)}
            </div>
          `
        : ""}
    </div>
  `;
}

function _renderRegexRuleInlineEditor(rule) {
  const trimStrings = Array.isArray(rule.trim_strings)
    ? rule.trim_strings.join("\n")
    : String(rule.trim_strings || "");

  return `
    <div class="bme-task-note">
      闂傚倷娴囬褏鈧稈鏅濈划娆撳箳濡炲皷鍋撻崘顔煎耿婵炴垼椴搁弲鈺呮倵閸忓浜鹃梺閫炲苯澧紒鍌氱Ч瀹曘劍绻濋崟鍨カ闂佽鍑界紞鍡樼濠靛鏁傞柍鈺佸暟缁?Tavern 婵犵數濮甸鏍窗濡ゅ啯宕查柟閭﹀枛缁躲倕霉閻樺樊鍎忛柛銊ュ€归妵鍕冀閵娧呯厒缂佺偓鍎抽妶鎼佸蓟閻旂厧绠氱憸婊堝吹閻斿吋鐓冪憸婊堝礈閿曞倸鍨傞弶鍫氭櫇閻岸鏌涘Δ鍐ㄤ汗闁衡偓娴犲鐓曢柕澶嬪灥閹冲繐鏆╅梻鍌欐祰椤曆囨煀閿濆拋鐒界憸蹇曟閻愬绡€闁告洦鍘鹃ˇ顖炴⒑閸撴彃浜栭柛搴㈢叀瀵煡顢楅崟顒€鈧爼鏌ｉ幇鐗堟锭濞存粓绠栭弻锝夊箻鐎靛憡鍣ч梺闈涙鐢帡锝炲┑瀣垫晢闁稿本鐟ㄥ鎼佹⒒娴ｇ瓔鍤冮柛鐘愁殜閵嗗啴宕奸姀鈽嗘綗闂佸湱鍎ら〃蹇涘极閸ヮ剚鐓熼柟瀛樼箖椤ユ粍绻涢崼婵勫仮婵﹨娅ｇ划娆戞崉閵娧呮澖闂備胶顭堥柊锝嗙閸洏鈧礁顫濋懜鐢靛姸閻庡箍鍎遍幊鎰八囬埡鍛厸濠㈣泛鑻禒锕€顭块悷鐗堫棦闁诡喚鍏樻慨鈧柕鍫濇閳ь剛鏁诲濠氬醇閻旇　濮囬柣鐘冲姧缁绘繈寮诲☉妯锋瀻闊洦绋戝鐗堢節?
    </div>

    <div class="bme-config-row">
      <label>闂傚倷娴囧畷鐢稿窗閹扮増鍋￠柕澹偓閸嬫挸顫濋悡搴♀拫閻庤娲栫紞濠囥€佸☉銏″€烽柤鑲╃礋閺囥垺鍊垫鐐茬仢閸旀碍绻?/label>
        <input
          class="bme-config-input"
          type="text"
          data-regex-rule-field="script_name"
          value="${_escAttr(rule.script_name || "")}"
        />
    </div>

    <label class="bme-toggle-item bme-task-editor-toggle">
      <span class="bme-toggle-copy">
        <span class="bme-toggle-title">闂傚倸鍊风粈渚€骞夐敓鐘茬鐟滅増甯掗崹鍌炴煙閹増顥夐柡瀣╃窔閺屾洟宕煎┑鍥ь€涘┑鐐烘？閸楁娊寮婚弴銏犻唶婵犻潧鐗嗛埛鍫濃攽閻愭彃鎮戦柛鏃€鐟╁?/span>
        <span class="bme-toggle-desc">闂傚倸鍊烽懗鍫曗€﹂崼銉晞闁糕剝鐟ラ崹婵嬪箹濞ｎ剙濡奸柡瀣╃窔閺屾洟宕煎┑鎰﹂柣鐔哥懕缁犳捇鐛弽顬ュ酣顢楅埀顒勫焵椤戞儳鈧繂鐣烽崹顐㈢窞闁归偊鍘兼禒顓炩攽閻愬弶顥滅紒缁樺姍椤㈡棃鍩￠崨顔惧幈濡炪値鍘介崹鐢告倶閿涘嫮纾奸悗锝庝憾濡插憡銇勯幘鐐藉仮鐎规洏鍔戦、姗€鎮㈤崫銉ョ祷闂傚倸鍊风粈渚€骞夐敓鐘冲仭闁靛鏅涚壕鐟邦渻鐎ｎ亝鎹ｇ紒鐘虫⒒閳ь剙鍘滈崑鎾绘煕閹板墎绱版慨瑙勵殜濮婅櫣鎲撮崟顐㈠Б闂佸摜鍠庡陇鐭鹃梺鍛婁緱閸旀儼銇愰幒鎾充汗婵炴挻鍑归崹鏉库枔椤撶喓绡€婵炲牆鐏濋弸銈夋煕閻樺啿濮嶉柡浣哥Ч楠炲洭寮剁捄顭戞Ч婵＄偑鍊栧ú鏍箠鎼淬劌鐤炬い鎾跺枔缁♀偓闂侀潧楠忕徊鍓ф兜妤ｅ啯鍊垫慨妯煎帶濞呭秵顨ラ悙鎻掓殲缂佺粯绻堝畷鍫曗€?/span>
      </span>
      <input
        type="checkbox"
        data-regex-rule-field="enabled"
        ${rule.enabled ? "checked" : ""}
      />
    </label>

    <div class="bme-config-row">
      <label>闂傚倸鍊风粈渚€骞栭銈嗗仏妞ゆ劧绠戠壕鍧楁煕濞嗗浚妲洪柣婵婂煐娣囧﹪顢涘▎鎺濆妳濠电偤妫块崡鎶藉蓟閵娿儮鏀介柛鈩兠▍锝夋⒑?(find_regex)</label>
      <textarea
        class="bme-config-textarea"
        data-regex-rule-field="find_regex"
        placeholder="/pattern/g"
      >${_escHtml(rule.find_regex || "")}</textarea>
    </div>

    <div class="bme-config-row">
      <label>闂傚倸鍊风粈渚€骞栭鈷氭椽鏁傞柨顖氫壕缂佹绋戦崯浼村汲閿曞倹鐓涢悘鐐额嚙閸旀碍淇婇锝忚€块柡灞剧洴婵＄兘鏁愰崨顓х€撮梻?(replace_string)</label>
      <textarea
        class="bme-config-textarea"
        data-regex-rule-field="replace_string"
        placeholder="闂傚倸鍊风粈渚€骞栭鈷氭椽鏁傞柨顖氫壕缂佹绋戦崯浼村汲閿曞倹鐓涢悘鐐额嚙閸旀岸鎮峰▎娆戠暤妤犵偞鐗楀蹇涘礈瑜忚摫闂備椒绱紞浣圭閸洖钃熼柨鐔哄Т绾惧吋鎱ㄥ鍡楀箹妞わ腹鏅涢埞鎴︽偐椤愵澀澹?
      >${_escHtml(rule.replace_string || "")}</textarea>
    </div>

    <div class="bme-config-row">
      <label>闂傚倷娴囧畷鐢稿窗瀹ュ拋娓婚柟鐑樻⒒閻棗霉閿濆懏璐￠柣婵嗙埣閺屽秷顧侀柛鎾跺枛楠炲啫螖閳ь剟鍩ユ径濞炬瀻婵☆垵宕甸弳顓熶繆閻愵亜鈧牠宕归幎鑺ュ€块柨鏂垮⒔閻?(trim_strings)</label>
      <textarea
        class="bme-config-textarea"
        data-regex-rule-field="trim_strings"
        placeholder="婵犵數濮甸鏍闯椤栨粌绶ら柣锝呮湰瀹曞弶淇婇妶鍛櫡闁逞屽厸缁舵岸鐛€ｎ喗鍊风痪鐗埳戦悘鍐⒒娓氣偓閳ь剛鍋涢懟顖涙櫠椤栨粎纾奸悗锝庝憾濡偓濡炪們鍨哄Λ鍐ㄧ暦閸洘鍤嬮柣銏㈡暩閸橆剟姊绘担钘夊惞闁哥姴绉撮—鍐箳濡や礁鈧潡鏌ㄩ弮鍌氫壕闁哄棙绮撻弻宥堫檨闁告挾鍠栧濠氭晲婢跺á鈺呮煏婢跺牆鍔村ù鐘层偢濮婃椽鎮滈埡渚囨綒闂佸憡渚楅崹鎶芥偩閸洘鈷戦柟绋垮椤ュ棝鏌涙惔鈽嗙吋闁?
      >${_escHtml(trimStrings)}</textarea>
    </div>

    <div class="bme-task-field-grid">
      <div class="bme-config-row">
        <label>闂傚倸鍊风粈渚€骞栭锔藉亱闁告劦鍠栫壕濠氭煙閸撗呭笡闁稿﹤鐖奸悡顐﹀炊閵婏箑鏆楃紓浣哄Ь鐏忔瑧妲愰幒鏃€濯肩€规洖娲ゆ俊浠嬫⒑?/label>
        <input
          class="bme-config-input"
          type="number"
          data-regex-rule-field="min_depth"
          value="${_escAttr(rule.min_depth ?? 0)}"
        />
      </div>
      <div class="bme-config-row">
        <label>闂傚倸鍊风粈渚€骞栭锔藉亱闁告劦鍠栫壕濠氭煙閻愵剙澧柣鏂挎閺屾盯顢曢姀鈽嗘闁诲孩鍑归崰姘卞垝婵犳艾绠虫俊銈傚亾缂?/label>
        <input
          class="bme-config-input"
          type="number"
          data-regex-rule-field="max_depth"
          value="${_escAttr(rule.max_depth ?? 9999)}"
        />
      </div>
    </div>

    <div class="bme-task-section-label">闂傚倸鍊峰ù鍥ь浖閵娾晜鍤勯柤绋跨仛濞呯姵淇婇妶鍌氫壕闂佷紮绲介悘姘辩箔閻旂厧鐒垫い鎺嗗亾妞ゆ洩缍佸畷濂稿即閻愬秲鍔戦弻銊╁棘閸喒鎸冮梺?/div>
    <div class="bme-task-toggle-list">
      <label class="bme-toggle-item">
        <span class="bme-toggle-copy">
          <span class="bme-toggle-title">闂傚倸鍊烽悞锕€顪冮崹顕呯劷闁秆勵殔缁€澶屸偓骞垮劚椤︻垶寮伴妷锔剧闁瑰鍋熼幊鍕磽瀹ュ懏鍠橀柡宀€鍠栭獮鍡氼槻闁哄棜浜埀?/span>
          <span class="bme-toggle-desc">闂傚倸鍊烽懗鍫曗€﹂崼銏″床閻庯綆鈧垹缍婂畷鍫曨敆婢跺娅撻梻濠庡亜濞诧箑顫忕憴鍕灁閻庢稒顭囩弧鈧繝鐢靛Т閸婂綊宕冲ú顏呯厸闁糕剝顨堢粻浼存?user / 闂傚倷绀侀幖顐λ囬鐐村亱濠电姴娲ょ粻浼存煙闂傚顦﹂柣顓燁殜閺屾盯鍩勯崘鍓у姺闂佽崵鍠庡﹢閬嶅箟閸涘﹥鍎熼柕濞垮劚閸ゆ垿姊洪崨濠傚Е闁哥姵鐗滈埀顒佽壘椤︿即濡甸崟顖氱闁挎棁濮ゅ▓浼存⒑?/span>
        </span>
        <input
          type="checkbox"
          data-regex-rule-source="user_input"
          ${(rule.source?.user_input ?? true) ? "checked" : ""}
        />
      </label>
      <label class="bme-toggle-item">
        <span class="bme-toggle-copy">
          <span class="bme-toggle-title">AI 闂傚倷绀侀幖顐λ囬鐐村亱濠电姴娲ょ粻浼存煙闂傚顦﹂柛?/span>
          <span class="bme-toggle-desc">闂傚倸鍊烽懗鍫曗€﹂崼銏″床閻庯綆鈧垹缍婂畷鍫曨敆婢跺娅撻梻濠庡亜濞诧箑顫忕憴鍕灁閻庢稒顭囩弧鈧繝鐢靛Т閸婂綊宕冲ú顏呯厸闁糕剝顨堢粻浼存?assistant / 闂傚倷绀侀幖顐λ囬鐐村亱濠电姴娲ょ粻浼存煙闂傚顦﹂柛姘愁潐閵囧嫰骞樼捄鐑樼亖闂佽崵鍠庡﹢閬嶅箟閸涘﹥鍎熼柕濞垮劚閸ゆ垿姊洪崨濠傚Е闁哥姵鐗滈埀顒佽壘椤︿即濡甸崟顖氱闁挎棁濮ゅ▓浼存⒑?/span>
        </span>
        <input
          type="checkbox"
          data-regex-rule-source="ai_output"
          ${(rule.source?.ai_output ?? true) ? "checked" : ""}
        />
      </label>
    </div>

    <div class="bme-task-section-label">濠电姷鏁搁崑鐘诲箵椤忓棗绶ら柛鎾楀啫鐏婇柟鍏肩暘閸斿矂寮告笟鈧弻鏇㈠醇濠垫劖效闂佺楠哥€涒晠濡甸崟顖氱睄闁稿本绋掗悵顏堟⒑?/div>
    <div class="bme-task-toggle-list">
      <label class="bme-toggle-item">
        <span class="bme-toggle-copy">
          <span class="bme-toggle-title">Prompt 闂傚倸鍊风粈渚€骞栭锔绘晞闁告侗鍨崑鎾愁潩閻撳骸顫紓?/span>
          <span class="bme-toggle-desc">闂傚倷绀佸﹢閬嶅储瑜旈幃娲Ω閵夘喗缍庢繝鐢靛У閼归箖寮告笟鈧弻鏇㈠醇濠垫劖笑缂備讲鍋?prompt 闂傚倷绀侀幖顐λ囬鐐村亱濠电姴娲ょ粻浼存煙闂傚顦﹂柣顓燁殜閺屾盯鍩勯崘顏佹闂佸憡鍨规繛鈧柡灞剧洴瀵挳濡搁妷銈囨晼缂傚倷鐒﹂崬鑽ょ不閹炬剚娼栨繛宸簼閸婇攱銇勯幒鍡椾壕缂備讲鍋撻柛鎰靛枟閻撶喐銇勯幘鍗炵伄闁伙絽鎼埞?/span>
        </span>
        <input
          type="checkbox"
          data-regex-rule-destination="prompt"
          ${(rule.destination?.prompt ?? true) ? "checked" : ""}
        />
      </label>
      <label class="bme-toggle-item">
        <span class="bme-toggle-copy">
          <span class="bme-toggle-title">闂傚倸鍊峰鎺旀椤旀儳绶ゅù鐘差儐閸庢鏌涚仦鎯у毈闁绘帊绮欓弻鐔封枔閸喗鐏嗗┑鐐茬焾娴滎亪寮婚敓鐘茬倞闁宠桨绲块悙瑁?/span>
          <span class="bme-toggle-desc">闂傚倷绀佸﹢閬嶅储瑜旈幃娲Ω閵夘喗缍庢繝鐢靛У閼归箖寮告笟鈧弻鏇㈠醇濠垫劖笑缂備讲鍋撻柛鈩冪⊕閻撴稑顭跨捄鍝勵劉缁绢叀鍩栫换娑㈠礂閸忓皷鎷荤紓浣介哺鐢繝宕洪埀顒併亜閹烘垵顏╁ù鑲╁█閺屾盯寮撮妸銉ョ闂佸憡娲熺粻鏍ь潖濞差亜浼犻柛鏇ㄥ墮椤︹晠鏌ｆ惔锝囨嚄闁告劦浜濆▓楣冩⒑閸濆嫯顫﹂柛搴㈢叀閹繝鏁愭径瀣幍闁荤喐鐟ョ€氼剚鎱ㄦ径鎰厽闁哄倹瀵ч崵鍥煛?/span>
        </span>
        <input
          type="checkbox"
          data-regex-rule-destination="display"
          ${rule.destination?.display ? "checked" : ""}
        />
      </label>
    </div>

    <div class="bme-task-expand-footer">
      <button
        class="bme-config-secondary-btn"
        data-task-action="toggle-regex-rule-expand"
        data-rule-id="${_escAttr(rule.id)}"
        type="button"
      >
        <i class="fa-solid fa-chevron-up"></i> 闂傚倸鍊峰ù鍥Υ閳ь剟鏌涚€ｎ偅宕岄柡宀€鍠栭、娑橆煥閸愮偓姣夐柣?
      </button>
    </div>
  `;
}

function _moveTaskBlock(blockId, direction) {
  if (!blockId || !Number.isFinite(direction) || direction === 0) return;
  _updateCurrentTaskProfile((draft) => {
    const blocks = _sortTaskBlocks(draft.blocks);
    const index = blocks.findIndex((item) => item.id === blockId);
    const targetIndex = index + direction;
    if (index < 0 || targetIndex < 0 || targetIndex >= blocks.length) {
      return null;
    }
    [blocks[index], blocks[targetIndex]] = [blocks[targetIndex], blocks[index]];
    // 闂傚倸鍊烽懗鍫曞磿閻㈢鐤炬繛鎴欏灪閸嬨倝鏌曟繛褍瀚▓浼存⒑閸︻叀妾搁柛鐘愁殜閹繝宕掑┃鎯т壕妤犵偛鐏濋崝姘繆椤愶絿鎳囬柟顕嗙節閸┾偓妞ゆ帒鍊荤壕浠嬫煕鐏炴崘澹橀柍褜鍓欑紞濠囧箖瑜斿瀛樺箠濞存粌缍婇弻娑滎槼妞ゃ劌妫濆鏌ヮ敆閸曨剙鈧爼鏌ｉ幇顖涚【濞存粌缍婇弻锝夋偄閸濄儳鐤勯梺璇″枤閸忔ê顕ｉ弶鎴僵濡插本鐗楄ⅵ闂傚倷绀侀幗婊堝疮閸ф纾?sort闂傚倸鍊烽悞锔锯偓绗涘懐鐭欓柟杈鹃檮閸嬪鏌涢埄鍐槈缂佺姵鑹鹃妴鎺戭潩閿濆懍澹曢柣搴ゎ潐濞叉﹢鎳濇ィ鍐ㄧ厺閹兼番鍨洪崕鐔兼煥濠靛棙宸濈€规洖鐖煎缁樻媴閸涘﹨纭€濡炪値鍘奸悧鎾规闂佸搫顦抽?order 闂傚倸鍊风粈浣革耿闁秴纾块柕鍫濇处閺嗘粓鏌熼悜妯烘婵炲樊浜滈崘鈧銈嗘尵閸嬫盯宕戝鍡欑闁哄鍨甸幃鎴︽煟閻旀繂鎳愰惌?
    draft.blocks = blocks.map((block, i) => ({ ...block, order: i }));
    return { selectBlockId: blockId };
  });
}

function _getTaskBlockDropPosition(row, clientY) {
  const rect = row.getBoundingClientRect();
  return clientY < rect.top + rect.height / 2 ? "before" : "after";
}

function _clearTaskBlockDragIndicators(workspace = document) {
  workspace
    .querySelectorAll(".bme-task-block-row.dragging, .bme-task-block-row.drag-over-top, .bme-task-block-row.drag-over-bottom")
    .forEach((row) => {
      row.classList.remove("dragging", "drag-over-top", "drag-over-bottom");
    });
}

function _setTaskBlockDragIndicator(workspace, activeRow, position) {
  workspace.querySelectorAll(".bme-task-block-row").forEach((row) => {
    if (row !== activeRow) {
      row.classList.remove("drag-over-top", "drag-over-bottom");
      return;
    }
    row.classList.toggle("drag-over-top", position === "before");
    row.classList.toggle("drag-over-bottom", position === "after");
  });
}

function _reorderTaskBlocks(sourceBlockId, targetBlockId, position = "before") {
  if (!sourceBlockId || !targetBlockId || sourceBlockId === targetBlockId) return;
  _updateCurrentTaskProfile((draft) => {
    const blocks = _sortTaskBlocks(draft.blocks);
    const sourceIndex = blocks.findIndex((item) => item.id === sourceBlockId);
    const targetIndex = blocks.findIndex((item) => item.id === targetBlockId);
    if (sourceIndex < 0 || targetIndex < 0) {
      return null;
    }

    const [sourceBlock] = blocks.splice(sourceIndex, 1);
    let insertIndex = targetIndex;

    if (sourceIndex < targetIndex) {
      insertIndex -= 1;
    }
    if (position === "after") {
      insertIndex += 1;
    }

    insertIndex = Math.max(0, Math.min(blocks.length, insertIndex));
    blocks.splice(insertIndex, 0, sourceBlock);
    draft.blocks = blocks.map((block, index) => ({ ...block, order: index }));
    return { selectBlockId: sourceBlockId };
  });
}

function _deleteTaskBlock(blockId) {
  if (!blockId) return;
  _updateCurrentTaskProfile((draft) => {
    const blocks = _sortTaskBlocks(draft.blocks);
    const index = blocks.findIndex((item) => item.id === blockId);
    if (index < 0) return null;
    const block = blocks[index];

    blocks.splice(index, 1);
    draft.blocks = _normalizeTaskBlocks(blocks);
    return {
      selectBlockId: blocks[Math.max(0, index - 1)]?.id || blocks[0]?.id || "",
    };
  });
}

function _deleteRegexRule(ruleId) {
  if (!ruleId) return;
  _updateCurrentTaskProfile((draft) => {
    const localRules = Array.isArray(draft.regex?.localRules)
      ? [...draft.regex.localRules]
      : [];
    const index = localRules.findIndex((item) => item.id === ruleId);
    if (index < 0) return null;
    localRules.splice(index, 1);
    draft.regex = {
      ...(draft.regex || {}),
      localRules,
    };
    return {
      selectRuleId:
        localRules[Math.max(0, index - 1)]?.id || localRules[0]?.id || "",
    };
  });
}

function _getRegexRuleDropPosition(row, clientY) {
  const rect = row.getBoundingClientRect();
  return clientY < rect.top + rect.height / 2 ? "before" : "after";
}

function _clearRegexRuleDragIndicators(workspace = document) {
  workspace
    .querySelectorAll(".bme-regex-rule-row.dragging, .bme-regex-rule-row.drag-over-top, .bme-regex-rule-row.drag-over-bottom")
    .forEach((row) => {
      row.classList.remove("dragging", "drag-over-top", "drag-over-bottom");
    });
}

function _setRegexRuleDragIndicator(workspace, activeRow, position) {
  workspace.querySelectorAll(".bme-regex-rule-row").forEach((row) => {
    if (row !== activeRow) {
      row.classList.remove("drag-over-top", "drag-over-bottom");
      return;
    }
    row.classList.toggle("drag-over-top", position === "before");
    row.classList.toggle("drag-over-bottom", position === "after");
  });
}

function _reorderRegexRules(sourceRuleId, targetRuleId, position = "before", isGlobal = false) {
  if (!sourceRuleId || !targetRuleId || sourceRuleId === targetRuleId) return;
  const applyReorder = (rules = []) => {
    const nextRules = Array.isArray(rules) ? [...rules] : [];
    const sourceIndex = nextRules.findIndex((item) => item.id === sourceRuleId);
    const targetIndex = nextRules.findIndex((item) => item.id === targetRuleId);
    if (sourceIndex < 0 || targetIndex < 0) {
      return null;
    }

    const [sourceRule] = nextRules.splice(sourceIndex, 1);
    let insertIndex = targetIndex;
    if (sourceIndex < targetIndex) {
      insertIndex -= 1;
    }
    if (position === "after") {
      insertIndex += 1;
    }
    insertIndex = Math.max(0, Math.min(nextRules.length, insertIndex));
    nextRules.splice(insertIndex, 0, sourceRule);
    return nextRules;
  };

  if (isGlobal) {
    _updateGlobalTaskRegex((draft) => {
      const localRules = applyReorder(draft.localRules);
      if (!localRules) return null;
      draft.localRules = localRules;
      return { selectRuleId: sourceRuleId };
    });
    return;
  }

  _updateCurrentTaskProfile((draft) => {
    const localRules = applyReorder(draft.regex?.localRules);
    if (!localRules) return null;
    draft.regex = {
      ...(draft.regex || {}),
      localRules,
    };
    return { selectRuleId: sourceRuleId };
  });
}

function _persistRegexRuleEnabledById(ruleId, enabled, isGlobal = false, refresh = true) {
  if (!ruleId) return;

  if (isGlobal) {
    _updateGlobalTaskRegex(
      (draft) => {
        const localRules = Array.isArray(draft.localRules) ? [...draft.localRules] : [];
        const rule = localRules.find((item) => item.id === ruleId);
        if (!rule) return null;
        rule.enabled = Boolean(enabled);
        draft.localRules = localRules;
        return { selectRuleId: currentGlobalRegexRuleId };
      },
      { refresh },
    );
    return;
  }

  _updateCurrentTaskProfile(
    (draft) => {
      const localRules = Array.isArray(draft.regex?.localRules)
        ? [...draft.regex.localRules]
        : [];
      const rule = localRules.find((item) => item.id === ruleId);
      if (!rule) return null;
      rule.enabled = Boolean(enabled);
      draft.regex = {
        ...(draft.regex || {}),
        localRules,
      };
      return { selectRuleId: currentTaskProfileRuleId };
    },
    { refresh },
  );
}

function _persistSelectedBlockField(target, refresh) {
  const field = target.dataset.blockField;
  if (!field) return;

  _updateCurrentTaskProfile(
    (draft, context) => {
      const blocks = _sortTaskBlocks(draft.blocks);
      const block = blocks.find((item) => item.id === currentTaskProfileBlockId);
      if (!block) return null;

      const rawValue =
        target instanceof HTMLInputElement && target.type === "checkbox"
          ? Boolean(target.checked)
          : target.value;

      let extraSettingsPatch = {};
      if (field === "enabled") {
        block.enabled = Boolean(rawValue);
      } else if (field === "content" && block.type === "legacyPrompt") {
        block.content = String(rawValue || "");
        const legacyField = getLegacyPromptFieldForTask(context.taskType);
        if (legacyField) {
          extraSettingsPatch[legacyField] = block.content;
        }
      } else {
        block[field] = String(rawValue || "");
      }

      draft.blocks = _normalizeTaskBlocks(blocks);
      return {
        extraSettingsPatch,
        selectBlockId: block.id,
      };
    },
    { refresh },
  );
}

function _persistGenerationField(target, refresh) {
  const key = target.dataset.generationKey;
  const valueType = target.dataset.valueType || "text";
  if (!key) return;

  _updateCurrentTaskProfile(
    (draft) => {
      draft.generation = {
        ...(draft.generation || {}),
        [key]: _parseTaskWorkspaceValue(target, valueType),
      };
    },
    { refresh },
  );
}

function _persistTaskInputField(target, refresh) {
  const key = target.dataset.inputKey;
  const valueType = target.dataset.valueType || "text";
  if (!key) return;

  _updateCurrentTaskProfile(
    (draft) => {
      draft.input = {
        ...(draft.input || {}),
        [key]: _parseTaskWorkspaceValue(target, valueType),
      };
    },
    { refresh },
  );
}

function _persistRegexConfigField(target, refresh) {
  const key = target.dataset.regexField;
  if (!key) return;

  _updateCurrentTaskProfile(
    (draft) => {
      draft.regex = {
        ...(draft.regex || {}),
        [key]:
          target instanceof HTMLInputElement && target.type === "checkbox"
            ? Boolean(target.checked)
            : target.value,
      };
    },
    { refresh },
  );
}

function _persistRegexSourceField(target, refresh) {
  const sourceKey = target.dataset.regexSource;
  if (!sourceKey) return;

  _updateCurrentTaskProfile(
    (draft) => {
      draft.regex = {
        ...(draft.regex || {}),
        sources: {
          ...(draft.regex?.sources || {}),
          [sourceKey]: Boolean(target.checked),
        },
      };
    },
    { refresh },
  );
}

function _persistRegexStageField(target, refresh) {
  const stageKey = target.dataset.regexStage;
  if (!stageKey) return;

  _updateCurrentTaskProfile(
    (draft) => {
      draft.regex = {
        ...(draft.regex || {}),
        stages: {
          ...(draft.regex?.stages || {}),
          [stageKey]: Boolean(target.checked),
        },
      };
    },
    { refresh },
  );
}

function _persistSelectedRegexRuleField(target, refresh) {
  _updateCurrentTaskProfile(
    (draft) => {
      const localRules = Array.isArray(draft.regex?.localRules)
        ? [...draft.regex.localRules]
        : [];
      const rule = localRules.find((item) => item.id === currentTaskProfileRuleId);
      if (!rule) return null;

      if (target.dataset.regexRuleField) {
        const field = target.dataset.regexRuleField;
        if (target instanceof HTMLInputElement && target.type === "checkbox") {
          rule[field] = Boolean(target.checked);
        } else if (["min_depth", "max_depth"].includes(field)) {
          const parsed = Number.parseInt(String(target.value || "").trim(), 10);
          rule[field] = Number.isFinite(parsed) ? parsed : 0;
        } else if (field === "trim_strings") {
          rule[field] = String(target.value || "");
        } else {
          rule[field] = String(target.value || "");
        }
      }

      if (target.dataset.regexRuleSource) {
        const sourceKey = target.dataset.regexRuleSource;
        rule.source = {
          ...(rule.source || {}),
          [sourceKey]: Boolean(target.checked),
        };
      }

      if (target.dataset.regexRuleDestination) {
        const destinationKey = target.dataset.regexRuleDestination;
        rule.destination = {
          ...(rule.destination || {}),
          [destinationKey]: Boolean(target.checked),
        };
      }

      draft.regex = {
        ...(draft.regex || {}),
        localRules,
      };
      return { selectRuleId: rule.id };
    },
    { refresh },
  );
}

function _deleteGlobalRegexRule(ruleId) {
  if (!ruleId) return;
  _updateGlobalTaskRegex((draft) => {
    const localRules = Array.isArray(draft.localRules) ? [...draft.localRules] : [];
    const index = localRules.findIndex((item) => item.id === ruleId);
    if (index < 0) return null;
    localRules.splice(index, 1);
    draft.localRules = localRules;
    return {
      selectRuleId:
        localRules[Math.max(0, index - 1)]?.id || localRules[0]?.id || "",
    };
  });
}

function _persistGlobalRegexField(target, refresh) {
  const key = target.dataset.regexField;
  if (!key) return;

  _updateGlobalTaskRegex(
    (draft) => {
      draft[key] =
        target instanceof HTMLInputElement && target.type === "checkbox"
          ? Boolean(target.checked)
          : target.value;
    },
    { refresh },
  );
}

function _persistGlobalRegexSourceField(target, refresh) {
  const sourceKey = target.dataset.regexSource;
  if (!sourceKey) return;

  _updateGlobalTaskRegex(
    (draft) => {
      draft.sources = {
        ...(draft.sources || {}),
        [sourceKey]: Boolean(target.checked),
      };
    },
    { refresh },
  );
}

function _persistGlobalRegexStageField(target, refresh) {
  const stageKey = target.dataset.regexStage;
  if (!stageKey) return;

  _updateGlobalTaskRegex(
    (draft) => {
      draft.stages = {
        ...(draft.stages || {}),
        [stageKey]: Boolean(target.checked),
      };
    },
    { refresh },
  );
}

function _persistSelectedGlobalRegexRuleField(target, refresh) {
  _updateGlobalTaskRegex(
    (draft) => {
      const localRules = Array.isArray(draft.localRules) ? [...draft.localRules] : [];
      const rule = localRules.find((item) => item.id === currentGlobalRegexRuleId);
      if (!rule) return null;

      if (target.dataset.regexRuleField) {
        const field = target.dataset.regexRuleField;
        if (target instanceof HTMLInputElement && target.type === "checkbox") {
          rule[field] = Boolean(target.checked);
        } else if (["min_depth", "max_depth"].includes(field)) {
          const parsed = Number.parseInt(String(target.value || "").trim(), 10);
          rule[field] = Number.isFinite(parsed) ? parsed : 0;
        } else if (field === "trim_strings") {
          rule[field] = String(target.value || "");
        } else {
          rule[field] = String(target.value || "");
        }
      }

      if (target.dataset.regexRuleSource) {
        const sourceKey = target.dataset.regexRuleSource;
        rule.source = {
          ...(rule.source || {}),
          [sourceKey]: Boolean(target.checked),
        };
      }

      if (target.dataset.regexRuleDestination) {
        const destinationKey = target.dataset.regexRuleDestination;
        rule.destination = {
          ...(rule.destination || {}),
          [destinationKey]: Boolean(target.checked),
        };
      }

      draft.localRules = localRules;
      return { selectRuleId: rule.id };
    },
    { refresh },
  );
}

function _updateCurrentTaskProfile(mutator, options = {}) {
  const settings = _getSettings?.() || {};
  const taskProfiles = ensureTaskProfiles(settings);
  const taskType = currentTaskProfileTaskType;
  const bucket = taskProfiles[taskType];
  const activeProfile =
    bucket?.profiles?.find((item) => item.id === bucket.activeProfileId) ||
    bucket?.profiles?.[0];

  if (!activeProfile) return null;

  const draft = _normalizeTaskProfileDraft(_cloneJson(activeProfile));
  const mutationResult = mutator?.(draft, {
      settings,
      taskProfiles,
      taskType,
      bucket,
      activeProfile,
    });

  if (mutationResult === null) return null;

  const result = mutationResult || {};

  const nextProfile = _normalizeTaskProfileDraft(result.profile || draft);
  const nextTaskProfiles = upsertTaskProfile(taskProfiles, taskType, nextProfile, {
    setActive: true,
  });

  if (Object.prototype.hasOwnProperty.call(result, "selectBlockId")) {
    currentTaskProfileBlockId = result.selectBlockId || "";
  }
  if (Object.prototype.hasOwnProperty.call(result, "selectRuleId")) {
    currentTaskProfileRuleId = result.selectRuleId || "";
  }

  return _patchTaskProfiles(
    nextTaskProfiles,
    result.extraSettingsPatch || {},
    {
      refresh: result.refresh === undefined ? options.refresh !== false : result.refresh,
    },
  );
}

function _normalizeTaskProfileDraft(profile = {}) {
  const draft = profile || {};
  draft.blocks = _normalizeTaskBlocks(draft.blocks);
  draft.regex = {
    enabled: true,
    inheritStRegex: true,
    sources: {
      global: true,
      preset: true,
      character: true,
    },
    stages: {
      input: true,
      output: true,
    },
    localRules: [],
    ...(draft.regex || {}),
    sources: {
      global: true,
      preset: true,
      character: true,
      ...(draft.regex?.sources || {}),
    },
    stages: {
      input: true,
      output: true,
      ...normalizeTaskRegexStages(draft.regex?.stages || {}),
    },
    localRules: Array.isArray(draft.regex?.localRules)
      ? draft.regex.localRules.map((rule) => ({
          ...rule,
          source: {
            user_input: true,
            ai_output: true,
            ...(rule?.source || {}),
          },
          destination: {
            prompt: true,
            display: false,
            ...(rule?.destination || {}),
          },
        }))
      : [],
  };
  return draft;
}

function _normalizeTaskBlocks(blocks = []) {
  return _sortTaskBlocks(blocks).map((block, index) => ({
    ...block,
    order: index,
  }));
}

function _sortTaskBlocks(blocks = []) {
  return [...(Array.isArray(blocks) ? blocks : [])].sort((a, b) => {
    const orderA = Number.isFinite(Number(a?.order)) ? Number(a.order) : 0;
    const orderB = Number.isFinite(Number(b?.order)) ? Number(b.order) : 0;
    return orderA - orderB;
  });
}

function _parseTaskWorkspaceValue(target, valueType = "text") {
  if (valueType === "tri_bool") {
    if (target.value === "true") return true;
    if (target.value === "false") return false;
    return null;
  }

  if (valueType === "number") {
    const raw = String(target.value || "").trim();
    if (!raw) return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return String(target.value || "").trim();
}

function _isGlobalRegexPanelTarget(target) {
  return target instanceof HTMLElement && Boolean(target.closest(".bme-global-regex-panel"));
}

function _normalizeGlobalRegexDraft(regex = {}) {
  const normalized = normalizeGlobalTaskRegex(regex || {}, "global");
  return {
    ...normalized,
    sources: {
      ...(normalized.sources || {}),
    },
    stages: {
      ...normalizeTaskRegexStages(normalized.stages || {}),
    },
    localRules: Array.isArray(normalized.localRules)
      ? normalized.localRules.map((rule, index) =>
          createLocalRegexRule("global", {
            ...rule,
            id: String(rule?.id || `global-rule-${index + 1}`),
          }),
        )
      : [],
  };
}

function _mergeImportedGlobalRegex(currentGlobalRegex = {}, importedGlobalRegex = null) {
  const current = _normalizeGlobalRegexDraft(currentGlobalRegex);
  if (
    !importedGlobalRegex ||
    typeof importedGlobalRegex !== "object" ||
    Array.isArray(importedGlobalRegex)
  ) {
    return {
      globalTaskRegex: current,
      mergedRuleCount: 0,
      replacedConfig: false,
    };
  }

  const imported = _normalizeGlobalRegexDraft(importedGlobalRegex);
  const mergedRules = dedupeRegexRules(
    [
      ...(Array.isArray(current.localRules) ? current.localRules : []),
      ...(Array.isArray(imported.localRules) ? imported.localRules : []),
    ],
    "global",
  );

  return {
    globalTaskRegex: {
      ...imported,
      localRules: mergedRules,
    },
    mergedRuleCount: Math.max(
      0,
      mergedRules.length -
        (Array.isArray(current.localRules) ? current.localRules.length : 0),
    ),
    replacedConfig: true,
  };
}

function _mergeProfileRegexRulesIntoGlobal(
  currentGlobalRegex = {},
  profile = null,
  options = {},
) {
  const merged = migrateLegacyProfileRegexToGlobal(
    _normalizeGlobalRegexDraft(currentGlobalRegex),
    profile,
    options,
  );
  return {
    ...merged,
    globalTaskRegex: _normalizeGlobalRegexDraft(merged.globalTaskRegex || {}),
  };
}

function _renderTaskInputField(field, value) {
  const effectiveValue = value != null && value !== "" ? value : field.defaultValue;

  if (field.type === "enum") {
    return `
      <div class="bme-config-row">
        <label>${_escHtml(field.label)}</label>
        <select
          class="bme-config-input"
          data-input-key="${_escAttr(field.key)}"
          data-value-type="text"
        >
          ${(field.options || [])
            .map(
              (item) => `
                <option value="${_escAttr(item.value)}" ${item.value === String(effectiveValue ?? "") ? "selected" : ""}>
                  ${_escHtml(item.label)}
                </option>
              `,
            )
            .join("")}
        </select>
        ${field.help ? `<div class="bme-config-help">${_escHtml(field.help)}</div>` : ""}
      </div>
    `;
  }

  return `
    <div class="bme-config-row">
      <label>${_escHtml(field.label)}</label>
      <input
        class="bme-config-input"
        type="number"
        min="0"
        value="${_escAttr(effectiveValue ?? "")}"
        data-input-key="${_escAttr(field.key)}"
        data-value-type="number"
      />
      ${field.help ? `<div class="bme-config-help">${_escHtml(field.help)}</div>` : ""}
    </div>
  `;
}

function _patchGlobalTaskRegex(globalTaskRegex, options = {}) {
  return _patchSettings(
    {
      globalTaskRegex: _normalizeGlobalRegexDraft(globalTaskRegex),
    },
    {
      refreshTaskWorkspace: options.refresh !== false,
    },
  );
}

function _updateGlobalTaskRegex(mutator, options = {}) {
  const settings = _getSettings?.() || {};
  const draft = _normalizeGlobalRegexDraft(_cloneJson(settings.globalTaskRegex || {}));
  const mutationResult = mutator?.(draft, { settings });
  if (mutationResult === null) return null;

  const result = mutationResult || {};
  const nextRegex = _normalizeGlobalRegexDraft(result.globalTaskRegex || draft);
  if (Object.prototype.hasOwnProperty.call(result, "selectRuleId")) {
    currentGlobalRegexRuleId = result.selectRuleId || "";
  }

  return _patchSettings(
    {
      globalTaskRegex: nextRegex,
      ...(result.extraSettingsPatch || {}),
    },
    {
      refreshTaskWorkspace:
        result.refresh === undefined ? options.refresh !== false : result.refresh,
    },
  );
}

function _downloadTaskProfile(taskProfiles, taskType, profile, globalTaskRegex = {}) {
  try {
    const payload = serializeTaskProfile(taskProfiles, taskType, profile?.id || "");
    payload.globalTaskRegex = _normalizeGlobalRegexDraft(globalTaskRegex || {});
    const fileName = _sanitizeFileName(
      `st-bme-${taskType}-${profile?.name || "profile"}.json`,
    );
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    toastr.success("濠电姷顣藉Σ鍛村磻閸涱収鐔嗘俊顖氱毞閸嬫挸顫濋悡搴ｄ桓濡炪們鍨洪悷鈺侇嚕閹绢喗鍋愭い鎰垫線婢规洟姊哄Ч鍥х伈婵炰匠鍛殰闁割偅娲橀悡鏇㈡煏閸繈顎楃€殿噮鍠楅〃銉╂倷瀹割喖鍓跺Δ鐘靛仜濞差參銆佸Δ鍛劦妞ゆ帒瀚哥紞?, "ST-BME");
  } catch (error) {
    console.error("[ST-BME] 闂傚倷娴囬褍霉閻戣棄鏋侀柟闂寸閸屻劎鎲搁弬璺ㄦ殾闁汇垹澹婇弫鍥煟閺傛崘顒熸繛鏉戝閺岋綁鎮╅崣澶婎槱閻熸粍婢橀崯鎾晲閻愬搫围闁告稑鍊归惄顖氼嚕閸洖鍨傛い鏇炴噸缁辨挻淇婇悙顏勨偓鏍ь潖閻熸噴鍝勎熸笟顖氭闂佸憡娲﹂崜姘辩礊閸ャ劊浜滈柟鎵虫櫅閸?", error);
    toastr.error(`濠电姷顣藉Σ鍛村磻閸涱収鐔嗘俊顖氱毞閸嬫挸顫濋悡搴ｄ桓濡炪們鍨洪悷鈺侇嚕閹绢喗鍋愭い鎰垫線婢规洟姊哄Ч鍥х伈婵炰匠鍛殰闁割偅娲橀悡鏇㈡煏閸繈顎楁鐐搭殘閳ь剙鐏氬妯尖偓姘煎幖椤洩绠涘☉杈ㄦ櫇闂? ${error?.message || error}`, "ST-BME");
  }
}
function _sanitizeFileName(fileName = "profile.json") {
  return String(fileName || "profile.json").replace(/[<>:"/\\|?*\x00-\x1f]/g, "-");
}

function _downloadAllTaskProfiles(taskProfiles, globalTaskRegex = {}) {
  try {
    const taskTypes = getTaskTypeOptions().map((t) => t.id);
    const profiles = {};
    for (const taskType of taskTypes) {
      try {
        const exported = serializeTaskProfile(taskProfiles, taskType);
        profiles[taskType] = exported;
      } catch {
        // skip missing
      }
    }
    if (Object.keys(profiles).length === 0) {
      toastr.warning("婵犵數濮烽弫鎼佸磻濞戞瑥绶為柛銉墮缁€鍫熺節闂堟稒锛旈柤鏉跨仢閵嗘帒顫濋敐鍛闁诲氦顫夊ú鈺冪礊娓氣偓閵嗕礁鈽夊鍡樺兊闂佺粯鎸哥€涒晠顢欓幘缁樷拻濞达絽鎲￠崯鐐烘煕閵娧冨付闁宠绉归弫鎰板川椤忓懐浜栭梻浣烘嚀椤曨參宕曢幋鐘愁潟闁挎繂顦伴悡鏇㈡煛閸ャ儱濡兼繛鍛耿閺?, "ST-BME");
      return;
    }
    const payload = {
      format: "st-bme-all-task-profiles",
      version: 1,
      exportedAt: new Date().toISOString(),
      globalTaskRegex: _normalizeGlobalRegexDraft(globalTaskRegex || {}),
      profiles,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = _sanitizeFileName("st-bme-all-profiles.json");
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    toastr.success(`闂備浇顕уù鐑藉箠閹捐绠熼梽鍥Φ閹版澘绀冩い鏇炴噺閺咁亪姊绘笟鍥у缂佸顕划?${Object.keys(profiles).length} 濠电姷鏁搁崑鐐哄垂閸洖绠归柍鍝勫€婚々鍙夌箾閸℃ɑ灏紒鐘崇叀閺屾洝绠涚€ｎ亖鍋撻弴鐘电焼濠㈣埖鍔栭悡銉╂煟閺傛寧鎯堟い搴＄焸閺岋繝宕卞Ο鑽ゎ槹闂佽鍠涢～澶愬箯閸涘瓨鎯為悷娆忓濡? "ST-BME");
  } catch (error) {
    console.error("[ST-BME] 闂傚倷娴囬褍霉閻戣棄鏋侀柟闂寸閸屻劎鎲搁弬璺ㄦ殾闁汇垹澹婇弫鍥煏韫囨洖啸妞は佸洦鈷戦梻鍫熷崟閸儱鐤炬繛鎴欏灩缁€澶愭煏婢跺牆鍓绘繛鎴欏灩缁狙囨煕椤垵娅樺ù鐓庡€搁—鍐Χ閸℃ǚ鎷瑰┑鐐插级閿氭い鏇樺劦瀹曠喖顢楁担铏剐ゆ俊鐐€栭崝鎴﹀磿?", error);
    toastr.error(`闂傚倷娴囬褍霉閻戣棄鏋侀柟闂寸閸屻劎鎲搁弬璺ㄦ殾闁汇垹澹婇弫鍥煏韫囨洖啸妞は佸洦鈷戦梻鍫熷崟閸儱鐤炬繛鎴欏灩缁€澶愭煏婢跺牆鍓绘繛鎴欏灩缁狙囨煕椤垵娅樺ù鐓庡€搁—鍐Χ閸℃ǚ鎷瑰┑鐐插级閿氭い鏇樺劦瀹曠喖顢楁担铏剐ゆ俊鐐€栭崝鎴﹀磿? ${error?.message || error}`, "ST-BME");
  }
}
function _cloneJson(value) {
  return JSON.parse(JSON.stringify(value ?? null));
}

function _helpTip(text) {
  if (!text) return "";
  return `<span class="bme-help-tip"><button type="button" class="bme-help-tip__trigger" aria-label="闂傚倷鐒﹂惇褰掑春閸曨垰鍨傚┑鍌滎焾缁愭鏌″鍐ㄥ闁?>?</button><span class="bme-help-tip__bubble">${_escHtml(text)}</span></span>`;
}

function _getTaskBlockTypeLabel(type) {
  const typeMap = {
    custom: "闂傚倸鍊烽懗鍫曞储瑜旈妴鍐╂償閵忋埄娲稿┑鐘诧工閻楀﹪宕戦埡鍛厽闁逛即娼ф晶浼存煃缂佹ɑ绀€妞ゎ叀娉曢幑鍕偖鐎涙ɑ鏆伴梻?,
    builtin: "闂傚倸鍊风粈渚€骞夐敓鐘茬闁哄洢鍨圭粻鐘绘煙閹殿喖顣奸柛瀣典邯閺屾盯鍩勯崘顏佹闂?,
    legacyPrompt: "闂傚倸鍊烽懗鍫曗€﹂崼銏″床闁圭儤顨呴崒銊ф喐閺冨牄鈧礁鈻庨幘宕囩杸闂佸搫顦锟犲极?,
  };
  return typeMap[type] || type || "闂?;
}

function _formatTaskProfileTime(raw) {
  if (!raw) return "闂傚倸鍊风粈渚€骞夐敍鍕殰婵°倕鎳忛崵灞轿旈敐鍛殭闁?;
  try {
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) return "闂傚倸鍊风粈渚€骞夐敍鍕殰婵°倕鎳忛崵灞轿旈敐鍛殭闁?;
    return date.toLocaleString("zh-CN", {
      hour12: false,
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "闂傚倸鍊风粈渚€骞夐敍鍕殰婵°倕鎳忛崵灞轿旈敐鍛殭闁?;
  }
}

// ==================== 闂備浇顕у锕傦綖婢舵劕绠栭柛顐ｆ礀绾惧潡姊洪鈧粔鎾儗濡ゅ懏鐓曠憸搴ㄣ€冮崨顖滅焼闁告洦鍨遍悡鐘绘煙椤撶喎绗掗柛鏃€绮嶇换?====================

function _setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = String(text);
}

function _getGraphPersistenceSnapshot() {
  return _getGraphPersistenceState?.() || {
    loadState: "no-chat",
    reason: "",
    writesBlocked: true,
    shadowSnapshotUsed: false,
    pendingPersist: false,
    lastAcceptedRevision: 0,
    persistMismatchReason: "",
    commitMarker: null,
    chatId: "",
    storageMode: "indexeddb",
    dbReady: false,
    syncState: "idle",
    syncDirty: false,
    syncDirtyReason: "",
    lastSyncUploadedAt: 0,
    lastSyncDownloadedAt: 0,
    lastSyncedRevision: 0,
    lastBackupUploadedAt: 0,
    lastBackupRestoredAt: 0,
    lastBackupRollbackAt: 0,
    lastBackupFilename: "",
    lastSyncError: "",
  };
}

function _getLatestBatchStatusSnapshot() {
  return _getLastBatchStatus?.() || null;
}

function _formatPersistenceOutcomeLabel(outcome = "") {
  switch (String(outcome || "")) {
    case "saved":
      return "闂備浇顕у锕傦綖婢舵劖鍋ら柡鍥╁剱閸ゆ洟鏌熼幑鎰厫鐎规洖寮堕幈銊ノ熺拠宸殺闂?;
    case "fallback":
      return "闂傚倸鍊烽懗鍫曗€﹂崼銏″床闁瑰濮撮崹婵堚偓鍏夊亾闁逞屽墴閹崇偤鏌嗗鍛槰閻庣懓澹婇崰鏍疾閻樼粯鈷掑┑鐘查娴滀粙鏌涘Ο鍝勨挃缂侇喚绮粋鎺斺偓锝庡亜閳?;
    case "queued":
      return "闂備浇顕ф绋匡耿闁秮鈧箓宕煎┑鎰闂佸憡鎸烽悞锕傚汲濠婂牊鐓欓柛鎾楀懎绗￠梺?;
    case "blocked":
      return "闂備浇顕уù鐑藉箠閹捐绠熼柨鐔哄У閸嬪倿鏌嶉妷锔剧獮闁绘梻鍘ч獮銏′繆椤栨繂浜归柣?;
    case "failed":
      return "濠电姷鏁告慨浼村垂濞差亜纾块柤娴嬫櫅閸ㄦ繈鏌涢幘妤€瀚弸?;
    default:
      return "闂傚倸鍊风粈渚€骞栭锔藉亱婵犲﹤瀚々鏌ユ煟閹邦喖鍔嬮柛?;
  }
}

function _formatDashboardPersistMeta(loadInfo = {}, batchStatus = null) {
  const persistence = batchStatus?.persistence || null;
  if (persistence) {
    const parts = [
      _formatPersistenceOutcomeLabel(persistence.outcome),
      persistence.storageTier ? `tier ${persistence.storageTier}` : "",
      Number.isFinite(Number(persistence.revision)) && Number(persistence.revision) > 0
        ? `rev ${Number(persistence.revision)}`
        : "",
      persistence.reason || "",
    ].filter(Boolean);
    return parts.join(" 闂?") || "闂傚倷娴囬褏鎹㈤幇顔藉床闁瑰濮撮弸鍫⑩偓骞垮劚閹叉ê鈽夐姀鐘栄冾熆鐠虹尨鍔熸い鏂挎处缁绘稒娼忛崜褏袦濡炪們鍎查幑鍥箖閻愵剛顩烽悗锝庡亞閸橀亶姊洪崫鍕犻柛鏂垮閺呭爼鎼归鐘辩盎闂佸搫鍊圭€笛呯矚閸ф鐓?;
  }

  const dualWrite = loadInfo?.dualWriteLastResult || null;
  if (dualWrite) {
    return [
      dualWrite.success === true ? "闂傚倸鍊风粈渚€骞栭锔藉亱闁告劦鍠栫壕濠氭煙閹规劦鍤欑紒鐙欏洦鐓冮柛婵嗗閳ь剚鎮傞幃姗€濡烽埡鍌滃幈闂佺粯鏌ㄩ幉鈥崇暦瀹€鈧埀顒冾潐濞叉﹢銆冩繝鍐х箚闁绘垼濮ら弲婵嬫煃瑜滈崜鐔煎箖濮椻偓瀹曞爼顢楁担鍝勫箞? : "闂傚倸鍊风粈渚€骞栭锔藉亱闁告劦鍠栫壕濠氭煙閹规劦鍤欑紒鐙欏洦鐓冮柛婵嗗閳ь剚鎮傞幃姗€濡烽埡鍌滃幈闂佺粯鏌ㄩ幉鈥崇暦瀹€鈧埀顒冾潐濞叉﹢銆冩繝鍐х箚闁绘垼妫勫敮闂佹寧绻傜€氼厼顭块埀顒勬⒒?,
      dualWrite.target || dualWrite.source || "",
      Number.isFinite(Number(dualWrite.revision)) && Number(dualWrite.revision) > 0
        ? `rev ${Number(dualWrite.revision)}`
        : "",
      dualWrite.reason || dualWrite.error || "",
    ]
      .filter(Boolean)
      .join(" 闂?");
  }

  return "闂傚倷娴囬褏鎹㈤幇顔藉床闁瑰濮撮弸鍫⑩偓骞垮劚閹锋垿鎳撻幐搴涗簻闁规儳宕悘鈺冪磼閻橆喖鍔ら柟鍙夋倐楠炲鏁傜悰鈥充壕濞撴埃鍋撴鐐差儔閺佸啴鍩€椤掑倻涓嶉柡澶嬶紩瑜版帗鏅插鑸瞪戦ˉ鏍⒑娴兼瑧瀵肩紒顔界懇瀵?;
}

function _formatDashboardHistoryMeta(graph = null, loadInfo = {}, batchStatus = null) {
  const lastConfirmedFloor =
    graph?.historyState?.lastProcessedAssistantFloor ?? -1;
  const persistence = batchStatus?.persistence || null;
  const processedRange = Array.isArray(batchStatus?.processedRange)
    ? batchStatus.processedRange
    : [];
  const pendingFloor =
    processedRange.length > 1 && Number.isFinite(Number(processedRange[1]))
      ? Number(processedRange[1])
      : null;

  if (persistence && persistence.accepted !== true && pendingFloor != null) {
    return `闂傚倸鍊风粈浣虹礊婵犲洤鐤鹃柟缁樺俯濞撳鏌熼悜妯烩拻濞戞挸绉电换娑㈠幢濡纰嶇紓浣插亾鐎光偓閸曨剛鍘搁悗瑙勬惄閸犳牠骞婇幇閭︽晛闁逞屽墰缁辨挻鎷呮ウ鎸庮€楅梺鍛婄懃闁帮絽鐣烽弶搴撴闁靛繆鏅滈弲锝嗙節閻㈤潧校缁炬澘绉瑰鏌ヮ敆娴ｇ懓寮垮┑顔筋殔濡鐛Δ鍛厵闁绘垶鍨濋幉楣冩煛鐏炲墽娲撮柡浣稿€块幊鐐哄Ψ瑜嶉崵鎺楁⒒娴ｅ憡鍟為柛鈺侊功閹广垹鈹戠€ｎ剙绁﹂柟鍏肩暘閸斿秶鈧數濮撮…璺ㄦ崉閻氭潙濮涢梺璇″枛閵堢顫忓ú顏勫窛濠电姴鍊婚鍌涚節閳封偓閸曞灚鐤佹繝纰樷偓宕囧煟闁硅櫕鐗犻崺锟犲焵椤掆偓閳?${pendingFloor}闂傚倸鍊烽悞锔锯偓绗涘懐鐭欓柟杈鹃檮閸ゆ劖銇勯弽顐粶缂佲偓閸曨垱鐓ユ繛鎴灻顏堟煕韫囨梻鐭嬮柕鍥у瀵噣鍩€椤掑嫷鏁勬繛鍡樻尭鐟欙箓鏌涢妷锝呭缂佽妫濋弻鏇㈠醇濠靛洦鎮欓柣銏╁灠閻栧ジ寮?${lastConfirmedFloor}`;
  }

  if (loadInfo?.persistMismatchReason) {
    return `闂傚倸鍊风粈浣虹礊婵犲洤鐤鹃柟缁樺俯濞撳鏌熼悜妯烩拻濞戞挸绉电换娑㈠幢濡纰嶇紓浣插亾鐎光偓閸曨剛鍘搁悗骞垮劚缁绘劙銆呴浣典簻闊洦绋愰幉楣冩煛鐏炶鈧洟鎮鹃敓鐘茬妞ゆ棁濮ら崰鏍⒒娓氣偓閳ь剛鍋涢懟顖炲礉椤栫偞鐓曢柟鏉垮悁缁ㄤ粙鏌ㄥ☉娆戠疄闁哄矉缍佹慨鈧柍杞拌兌娴犵鈹戦悙璺侯棈鐎规洟娼у嵄?{String(loadInfo.persistMismatchReason || "")} 闂?闂備浇顕у锕傦綖婢舵劖鍋ら柡鍥╁С閻掑﹥绻涢崱妯诲碍闁诲繗娅曟穱濠囶敍濮橆剚鍊繝娈垮灠閵堟悂寮婚弴銏犻唶婵犻潧娴傚Λ鎴︽⒑缁嬭法鎳夐柛銉ｅ妼閳?${lastConfirmedFloor}`;
  }

  const dirtyFrom = graph?.historyState?.historyDirtyFrom;
  if (Number.isFinite(dirtyFrom)) {
    return `闂傚倸鍊风粈渚€宕ョ€ｎ亶鐒芥繛鍡樺灦瀹曟煡鏌熼柇锕€鏋欓柣鎺戯攻閵囧嫰寮介妸褋鈧帗銇勯埡鍐ㄥ幋妤犵偞鐗犻獮鏍敇閻斿皝鏋忛梻浣侯焾閻燁亪宕堕妸銉㈠亾?${dirtyFrom} 闂備浇顕х€涒晠顢欓弽顓炵獥闁圭儤顨呯壕濠氭煙閻愵剚鐏遍柡鈧懞銉ｄ簻闁哄啫鍊甸幏锟犳煕鎼淬垻鐭岀紒杈ㄥ笚濞煎繘濡歌閻ｉ潧顪冮妶鍡樼叆缂佺粯锕㈤獮濠囨偐濞茬粯鏅為柣鐔哥懕缁茶姤绂嶉悙顑跨箚妞ゆ牗鑹鹃幃鎴濃攽椤栨哎鍋㈤柡灞炬礋瀹曠厧鈹戦崶褜鈧稑鈹戦埄鍐弨濞存粌鐖煎濠氭晲婢跺鈧兘鏌涘▎蹇ｆ▓婵☆偆鍋ゅ铏瑰寲閺囩喐鐝旈梺鍏兼た閸ㄧ敻鎮橀崘顔解拺缂備焦蓱鐏忣厽绻涢弶鎴濇Щ闁?${lastConfirmedFloor}`;
  }

  return `婵犲痉鏉库偓妤佹叏閻戣棄纾婚柣鎰堪娴滃綊鏌涢幇闈涙灈闂傚偆鍨堕弻銊モ攽閸♀晜效闂佸搫鎷嬮崜鐔煎箖濮椻偓閹瑩鎳滃▓鎸庮棄闂備焦鎮堕崐鏍暜閻愮儤鍎夋い蹇撶墱閺佸洨鎲稿澶婂嚑闁挎柨顫曟禍婊堟煙閹冾暢閻㈩垱绋撻埀顒€鐏氬妯尖偓姘緲閻ｇ兘鎮㈢喊杈ㄦ櫍闂佺粯鏌ㄩ惃婵嬪磻閹剧粯鍊烽柣鎴烆焽閸橀亶姊洪崷顓炲妺闁哄被鍔戦妴鍌涚附閸涘﹦鍘梺鍓插亾缁茶姤绂嶉悷鎳?${lastConfirmedFloor}`;
}

function _getGraphLoadLabel(loadState = "") {
  switch (loadState) {
    case "loading":
      return "婵犵數濮甸鏍窗濡ゅ啯宕查柟閭﹀枛缁躲倝鏌﹀Ο渚闁肩増瀵ч妵鍕疀閹捐泛顣虹紓浣插亾濠㈣埖鍔栭悡鐔镐繆椤栨粌甯堕柛鏂款儑缁辨帗鎷呴悷閭︽闂佺懓寮堕幃鍌炲箖瑜斿畷濂告偄妞嬪寒鏆℃繝鐢靛Л閹峰啴宕ㄩ娑欑€伴梻浣侯攰濞呮洖煤濡吋宕叉繝闈涱儏绾惧吋淇婇婊勫殌闁搞倝浜跺缁樻媴鐟欏嫬浠╅梺绋垮瑜板啴鎮惧畡鎷旂喐绗熼娑樺厞?;
    case "shadow-restored":
      return "闂備浇顕у锕傦綖婢舵劖鍋ら柡鍥╁剱閸ゆ洟鏌熼幑鎰【闁搞劍绻堥弻锝呂熷▎鎯ф闁诲孩鑹鹃ˇ浼村Φ閸曨垰绠崇€广儱娲╃粣妤呮⒑缁嬭法鎳夐柛蹇曞Т缂嶅﹤鐣峰Δ鍛拻缂傚牏濮撮銏ゆ⒒娴ｉ涓茬紒鐘冲笚閹便劑濡堕崶鈺冪厯婵犮垼娉涙径鍥磻閹炬枼妲堟繛鍛版珪閸ㄨ儻妫熼悷婊勬瀵鎮㈢喊杈ㄦ櫍濠电姴锕ら崯鐗堢閻撳寒娓婚柕鍫濈箻濡绢噣鏌ｉ幙鍕瘈鐎殿噮鍋勯濂稿炊閿旇棄濯扮紓鍌氬€烽梽宥夊垂鐟欏嫪绻嗙憸鏂款潖濞差亝顥堥柍鍝勫椤︿即姊洪崨濠冪叆闂佸府缍侀獮鍐洪鍕吅濠电姴鐏氶崝鏇炩枔椤愶附鈷戦柛娑橈梗缁堕亶鏌涢敐搴℃珝鐎规洘绻堥崺鈧い鎺戝閸婂灚绻涢崼婵堜虎闁哄绋撶槐鎺旂磼濮楀棙鐣风紓浣稿€哥粔褰掑箖瑜斿畷鐓庘攽閸垻宓侀梻鍌欑閻ゅ洤顩奸妸褏鐭嗗ù锝囧劋閺嗘粍淇婇妶鍛櫤闁绘挻绋戦湁闁挎繂鎳忛幆鍫熴亜閿濆牆浜归柍?;
    case "empty-confirmed":
      return "闂備浇宕甸崰鎰垝鎼淬垺娅犳俊銈呮噹缁犱即鏌涘☉姗堟敾婵炲懐濞€閺岋絽螣閼测晛绗￠梺鎼炲€曢崐鎼佸煘閹达附鍋愰柟缁樺坊閸嬫捇鎳滈悽娈挎锤濡炪倖鐗滈崑娑氱棯瑜旈弻宥夊传閸曨亞瑙﹂梺纭呮彧闂勫嫰宕曟径鎰厱婵炴垶鐟︾紞鎴︽倵濮橆剦妲告い顓℃硶閹瑰嫰鎮€涙ɑ鏆扮紓鍌欑閸婃悂鎮ч幘璇茬畺?;
    case "blocked":
      return "闂傚倸鍊烽懗鍫曞储瑜嶉悾鐑筋敆閸曨剚娅囬梺闈涚墕椤︻垱顢婂┑鐘灱閸╂牠宕濋弴鐘电焼闁稿瞼鍋為悡鏇㈡煙閼割剙濡芥繛鍛缁绘盯宕煎┑鍫濈厽闂佸搫鐬奸崰鎾诲箯閻樿鐏抽柧蹇ｅ亞娴滆埖绻濋悽闈浶涢柛瀣尰閵囧嫰骞樼捄鐩掞繝鏌ｉ幒鎴含鐎殿喖鐖煎畷鐓庮潩椤撶喓褰呴柣搴ゎ潐濞叉ê煤閻旂厧钃熼柕濞垮劗濡插牊淇婇姘变虎妞ゅ浚鍙冨娲川婵犲倻鍘愮紓浣虹帛缁诲倿顢氶敐澶婄闁芥ê顦遍敍婊冣攽椤旀枻渚涢柛瀣缁嬪顓兼径瀣ф嫼闂佺鍋愰崑娑㈠礉濠婂應鍋撶憴鍕闁挎碍銇勯锝囩疄濠碘剝鎮傞崺鈩冩媴娓氼垱袨濠电姷鏁搁崑娑樜涘Δ鍐╁床闁瑰濮烽惌鍡涙煃瑜滈崜姘辨崲濞戞埃鍋撻悽娈跨劸鐞氥劑姊虹粙鍨劉濠㈢懓妫濋獮鎴﹀閻欌偓濞尖晠鎮规ウ鎸庮仩妞ゆ柨鎳樺娲濞戞艾顣哄┑鈽嗗亝閻熲晠寮鍥ｅ亾閿濆骸鏋熼柣鎾寸☉闇夐柨婵嗘噺閹牊銇勯敐鍫濅汗闁?;
    case "loaded":
      return "闂傚倸鍊烽懗鍫曞储瑜嶉悾鐑筋敆閸曨剚娅囬梺闈涚墕椤︻垱顢婂┑鐘灱閸╂牠宕濋弴銏″€峰┑鐘叉处閻撴瑩鎮峰▎蹇擃仼濠殿喖鐗撻弻锝夊Ω閿曗偓閻忊晠鏌嶈閸撴盯骞婇幘璇茬疅闂勫洭濡甸幇鏉跨闁冲搫鍊稿鍧楁⒑缂佹ê濮囬柣掳鍔嶉幈?;
    case "no-chat":
    default:
      return "闂備浇宕甸崰鎰垝鎼淬垺娅犳俊銈呮噹缁犱即鏌涘☉姗堟敾婵炲懐濞€閺岋絽螣閸濆嫭鍊庨梺缁樺笒閿曘儵骞堥妸銉建闁糕剝顨呯粻娲倵濞堝灝鏋熼柟鐟版搐椤曪綁宕奸弴鐐靛幐闂佺鏈竟鏇炍ｉ崼銉︹拺闁告稑锕﹂幊鍐╀繆椤愶絿绠炴鐐诧躬瀵挳鎮㈤搹鍦闂備胶顭堥張顒傛箒闂?;
  }
}

function _canRenderGraphData(loadInfo = _getGraphPersistenceSnapshot()) {
  return (
    loadInfo.dbReady === true ||
    loadInfo.loadState === "loaded" ||
    loadInfo.loadState === "empty-confirmed" ||
    loadInfo.shadowSnapshotUsed === true
  );
}

function _isGraphWriteBlocked(loadInfo = _getGraphPersistenceSnapshot()) {
  if (typeof loadInfo.dbReady === "boolean" && !loadInfo.dbReady) {
    return true;
  }
  return Boolean(loadInfo.writesBlocked);
}

function _renderStatefulListPlaceholder(listEl, text) {
  if (!listEl) return;
  const li = document.createElement("li");
  li.className = "bme-recent-item";
  const content = document.createElement("div");
  content.className = "bme-recent-text";
  content.style.color = "var(--bme-on-surface-dim)";
  content.textContent = text;
  li.appendChild(content);
  listEl.replaceChildren(li);
}

function _refreshGraphAvailabilityState() {
  const loadInfo = _getGraphPersistenceSnapshot();
  const banner = document.getElementById("bme-action-guard-banner");
  const graphOverlay = document.getElementById("bme-graph-overlay");
  const graphOverlayText = document.getElementById("bme-graph-overlay-text");
  const mobileOverlay = document.getElementById("bme-mobile-graph-overlay");
  const mobileOverlayText = document.getElementById("bme-mobile-graph-overlay-text");
  const blocked = _isGraphWriteBlocked(loadInfo);
  const loadLabel = _getGraphLoadLabel(loadInfo.loadState);

  GRAPH_WRITE_ACTION_IDS.forEach((id) => {
    const button = document.getElementById(id);
    if (!button) return;
    button.disabled = blocked;
    button.classList.toggle("is-runtime-disabled", blocked);
    button.title = blocked ? loadLabel : "";
  });

  if (banner) {
    const shouldShowBanner = blocked;
    banner.hidden = !shouldShowBanner;
    banner.textContent = shouldShowBanner ? loadLabel : "";
  }

  const shouldShowOverlay =
    blocked ||
    loadInfo.syncState === "syncing" ||
    loadInfo.loadState === "loading" ||
    loadInfo.loadState === "shadow-restored" ||
    loadInfo.loadState === "blocked";

  if (graphOverlay) {
    graphOverlay.hidden = !shouldShowOverlay;
    graphOverlay.classList.toggle("active", shouldShowOverlay);
  }
  if (graphOverlayText) {
    graphOverlayText.textContent = shouldShowOverlay ? loadLabel : "";
  }
  if (mobileOverlay) {
    mobileOverlay.hidden = !shouldShowOverlay;
    mobileOverlay.classList.toggle("active", shouldShowOverlay);
  }
  if (mobileOverlayText) {
    mobileOverlayText.textContent = shouldShowOverlay ? loadLabel : "";
  }
}

function _refreshRuntimeStatus() {
  const runtimeStatus = _getRuntimeStatus?.() || {};
  const text = runtimeStatus.text || "闂備浇顕ф鎼佹倶濮橆剦鐔嗘慨妞诲亾妤犵偛锕ラ幆鏃堝Ω閵壯呮瀮?;
  const meta = runtimeStatus.meta || "闂傚倸鍊风粈渚€骞夐敓鐘插瀭闂傚牊鍏氬☉妯滄棃宕ラ挊澶嬪枠妞ゃ垺顨婂畷鎺戔枎閹存繂鈷曢梻浣告惈椤︻垶鎮ч崘顔肩柧婵炴垶顭囬弳?;
  _setText("bme-status-text", text);
  _setText("bme-status-meta", meta);
  _setText("bme-panel-status", text);
  _renderCloudStorageModeStatus(
    _getSettings?.() || {},
    _getGraphPersistenceSnapshot(),
  );
  _refreshGraphAvailabilityState();
}

function _showActionProgressUi(label, meta = "闂傚倷娴囧畷鍨叏閺夋嚚娲敇閳跺搫顦甸獮妯兼嫚閼碱剙骞楅梻渚€娼х换鍫ュ磹閺囩姴顥氶悷娆忓缁犻箖鏌涢埄鍐炬當妞わ富鍓熼弻?) {
  _setText("bme-status-text", `${label}濠电姷鏁搁崑鐐哄垂閸洖绠板Δ锝呭暙缁?;
  _setText("bme-status-meta", meta);
  _setText("bme-panel-status", `${label}濠电姷鏁搁崑鐐哄垂閸洖绠板Δ锝呭暙缁?;
  updateFloatingBallStatus("running", `${label}濠电姷鏁搁崑鐐哄垂閸洖绠板Δ锝呭暙缁?;
}

function _refreshCloudStorageModeUi(settings = _getSettings?.() || {}) {
  const mode = String(settings?.cloudStorageMode || "automatic");
  const manualActions = document.getElementById(
    "bme-cloud-backup-manual-actions",
  );
  const helpText = document.getElementById("bme-cloud-storage-mode-help");

  if (manualActions) {
    manualActions.style.display = mode === "manual" ? "flex" : "none";
  }
  if (helpText) {
    helpText.textContent =
      mode === "manual"
        ? "闂傚倸鍊风粈浣虹礊婵犲偆鐒界憸鏃堛€侀弽顓炲窛妞ゆ棁妫勫鍧楁⒑閸愬弶鎯堥柟鍐叉捣婢规洘绺介崨濠勫帾婵犵數鍋涢悘婵嬪礉閵堝鐓欓柣锝呰嫰瀛濋梺瀹犳椤︾敻鐛Ο铏规殾闁搞儱妫寸槐鏇犳閹烘鐭楁俊顖氭惈缁侇噣姊虹涵鍛彧闁烩晩鍨堕妴渚€寮崼婵堫槹濡炪倖鍔曠粔鐢搞€冮崨鏉戠叀濠㈣埖鍔曠粻鑽ょ磼濞戞粠娼愭い锝堝亹缁辨挻鎷呯粙鑳煘闂佺粯鐗曢妶鎼佹偘椤旈敮鍋撻敐搴℃灈闁告劏鍋撴俊鐐€栫敮鎺椝囨导瀛樺殝鐟滅増甯楅埛鎴︽煟閹存梹娅嗘繛鍛閺岋絽螖娴ｅ厜鎷婚梺鍏兼そ娴滃爼銆佸☉姗嗙叆闁告侗鍘肩憴锔戒繆閻愵亜鈧牠鎮ч幘璇茬９婵°倕鎳愬畵渚€鏌曡箛瀣偓鏍偂閺囥垺鐓欓柣鎴灻悘锔剧磼鐏炴儳顕滈柕鍥у瀵噣鍩€椤掆偓鐓ゆ俊顖欒閸ゆ鏌涢弴銊ョ仩闁绘劕锕弻鏇熺節韫囨挾妲ｅ┑鈥虫▕閸ㄥ爼寮婚敐澶嬪亹闁告瑥顦伴幃娆撴⒑閹肩偛鐏柣鎾偓宕囨殾闁靛繒濮Σ鍫ユ煏韫囧ň鍋撻弬銉ヤ壕闁绘垼濮ら悡鏇㈢叓閸ャ劍鎯勬俊鍙夋尦閺屾稓鈧綆鍋呯亸顓熴亜椤撴粌濮傜€规洘锕㈤幃娆擃敄椤愵剛绋荤紒缁樼〒閳ь剛鏁搁…鍫ョ€锋繝纰樻閸嬪嫮鈧碍婢橀悾鐑芥惞闁稒鍕冮梺鍛婃寙鐏為箖鏁滈梻鍌欒兌閹虫捇顢氶鐔峰灁妞ゆ挾鍠庨閬嶆煕瀹€鈧崑鐐烘偂閸愵喗鐓忓鑸电☉椤╊剛绱掗悩鍐差棆缂佽鲸甯楀蹇涘Ω瑜忛悿鍕倵鐟欏嫭绀冮柨姘亜閹剧偨鍋㈢€规洏鍔戦、娆撳垂椤旇棄鍓甸梻鍌氬€风粈渚€骞夐敓鐘冲仭閺夊牃鏅濈壕鑺ユ叏濡じ鍚柛妤佸哺閺岀喓绱掗姀鐘崇亪闂佹椿鍘介〃濠囧蓟閻旈鏆嬮柟娈垮枤閸旀悂姊洪崫銉ユ瀻濡ょ姵鎮傞垾锔炬崉閵婏箑纾梺缁樺灦閿氱紒鎰洴濮婅櫣绮欏▎鎯у妧缂傚倸绉崇欢姘暦瑜版帒绠氱憸婊堟偂閵夆晜鐓冪憸婊堝礈濞戙垹绀嗛柟鐑橆殕閸嬫劗鈧娲栧ù鍌毭洪幖浣光拺闁荤喖鍋婇崵鐔封攽椤栵絽骞楅悗闈涖偢瀹曟帡鎮欑€电骞橀梻浣筋嚃閸ㄥ酣宕橀埞顑芥櫊閹嘲顭ㄩ崟顒傚嚒濠电偠顕滅粻鎴︻敋閵夆晛绀嬫い鏍ㄦ皑閸婄偤姊洪幐搴㈢５闁稿鎹囬弻鈩冩媴閸︻厾鐓夐梺鍝勮嫰缁夎淇婇悜鑺ユ櫆闁告挆鍛崶闂?
        : "闂傚倸鍊烽懗鍫曞储瑜旈妴鍐╂償閵忋埄娲稿┑鐘诧工鐎氼參宕ｈ箛娑欑厓闁告繂瀚崳鍦棯閹佸仮闁哄本娲樼换娑㈠垂椤旂厧袘闂備礁婀遍弲顐ｆ叏閹绢喗绠掗梻浣侯焾缁绘劙宕ョ€ｎ喗鍎嶉柟杈鹃檮閻撴瑩鏌熺紒銏犳珮婵☆偅鍨圭槐鎺撴綇閵娿儲璇炲銈冨灪閿曘垽骞冮姀銈嗗亗閹肩补鈧壙鎾绘⒒閸屾瑧鍔嶆俊鐐茬仢椤洭宕稿Δ鈧粈澶屸偓鍏夊亾闁逞屽墰濡叉劙鎮欑喊妯轰壕闁挎繂楠搁弸娑氱磼閳ь剟宕奸埗鈺佷壕妤犵偛鐏濋崝姘亜閿旇姤绶查柍缁樻崌瀵噣宕奸悢鍝勫箞闁诲骸绠嶉崕閬嶅箠閹邦喚涓嶅ù鐓庣摠閻撴瑦銇勯弮鍥撻悘蹇ｅ幗閵囧嫰顢曢悩鑼紙婵犵绱曢崗姗€宕洪悙鍝勭畾鐟滃本绔熼弴銏♀拺闁告繂瀚鈺冪磼缂佹ê绗ч柡渚囧櫍瀹曞崬顪冪紒姗嗘綌闂備浇顫夊畷妯衡枍閺囥垹鑸瑰璺烘湰閸嬫牗绻濋棃娑卞剱闁绘挻娲樼换娑㈠幢濡搫顫岄梺璇查獜闂勫嫭绌辨繝鍥ㄥ€烽柟缁樺坊閸嬫捇宕归鍛闂佹眹鍨婚…鍫㈢不閹烘鐓欓柛婵嗗椤ユ粌霉?;
  }
  _renderCloudStorageModeStatus(settings, _getGraphPersistenceSnapshot());
  void _refreshCloudBackupManualUi(settings);
}

function _formatCloudTimeLabel(timestamp) {
  const normalized = Number(timestamp);
  if (!Number.isFinite(normalized) || normalized <= 0) return "";
  try {
    return new Date(normalized).toLocaleString();
  } catch {
    return "";
  }
}

function _renderCloudStorageModeStatus(
  settings = _getSettings?.() || {},
  loadInfo = _getGraphPersistenceSnapshot(),
) {
  const statusEl = document.getElementById("bme-cloud-storage-mode-status");
  if (!statusEl) return;

  const mode = String(settings?.cloudStorageMode || "automatic");
  if (mode !== "manual") {
    statusEl.style.display = "none";
    statusEl.textContent = "";
    return;
  }

  const lines = [];
  const syncDirty = Boolean(loadInfo?.syncDirty);
  const backupUploadedAt = Number(loadInfo?.lastBackupUploadedAt) || 0;
  const backupRestoredAt = Number(loadInfo?.lastBackupRestoredAt) || 0;
  const backupRollbackAt = Number(loadInfo?.lastBackupRollbackAt) || 0;
  const backupFilename = String(loadInfo?.lastBackupFilename || "").trim();
  const dualWrite = loadInfo?.dualWriteLastResult || null;
  const dualWriteAt = Number(dualWrite?.at) || 0;
  const needsPostRecoveryBackup =
    Boolean(dualWrite?.success) &&
    ["migration", "identity-recovery"].includes(String(dualWrite?.action || "")) &&
    dualWriteAt > backupUploadedAt;

  if (syncDirty) {
    const dirtyReason = String(loadInfo?.syncDirtyReason || "").trim();
    lines.push(
      dirtyReason
        ? `闂備浇宕甸崰鎰垝鎼淬垺娅犳俊銈呮噹缁犱即鏌涘☉姗堟敾婵炲懐濞€閺岋絽螣閼测晛绗￠梺鎼炲€曢崐鎼佸煘閹达附鍋愰柟缁樺坊閸嬫捇鎳滈悽娈挎锤濡炪倖鐗滈崑鐐烘偂濞戙垺鐓曟い鎰剁悼缁犮儲淇婇懠棰濇綈缂佺粯绻堥崺鈧い鎺戝閺佸洭鏌ｉ弮鍫缂佹劗鍋ゅ娲箹閻愭彃濮风紓浣哄У閸ㄥ灝顕ｉ銏╃叆闁割偆鍠撻崢浠嬫⒑闂堟侗鐒鹃柛搴ㄤ憾椤㈡棃顢旈崨顖滅槇闂侀€炲苯澧悗闈涖偢瀵爼骞嬮悙鑼偠闂傚倷鑳剁划顖炪€冮崨瀛樺亱濠电姴娲ゅЧ鍙夈亜閹惧崬鐏柣鎾存礋閺岋繝宕掑┑鎰婵犵鍓濋幃鍌炲蓟瀹ュ牜妾ㄩ梺鍛婃尰閻熲晛鐣烽幇鏉夸紶闁靛闄勫▓鏉款渻閵堝棗濮х紒鐘冲灴閹瑦绻濋崶銊у幗濠电偛妫楃换鎴﹀闯閻ｅ瞼纾?{dirtyReason}闂傚倸鍊风欢姘焽瑜嶈灋闁哄啫鍊瑰畷?
        : "闂備浇宕甸崰鎰垝鎼淬垺娅犳俊銈呮噹缁犱即鏌涘☉姗堟敾婵炲懐濞€閺岋絽螣閼测晛绗￠梺鎼炲€曢崐鎼佸煘閹达附鍋愰柟缁樺坊閸嬫捇鎳滈悽娈挎锤濡炪倖鐗滈崑鐐烘偂濞戙垺鐓曟い鎰剁悼缁犮儲淇婇懠棰濇綈缂佺粯绻堥崺鈧い鎺戝閺佸洭鏌ｉ弮鍫缂佹劗鍋ゅ娲箹閻愭彃濮风紓浣哄У閸ㄥ灝顕ｉ銏╃叆闁割偆鍠撻崢浠嬫⒑闂堟侗鐒鹃柛搴ㄤ憾椤㈡棃顢旈崨顖滅槇闂侀€炲苯澧悗闈涖偢瀵爼骞嬮悙鑼偠闂傚倷鑳剁划顖炪€冮崨瀛樺亱濠电姴娲ゅЧ鍙夈亜閹惧崬鐏柣鎾存礋閺岋繝宕掑┑鎰婵犵鍓濋幃鍌炲蓟?,
    );
  } else if (backupUploadedAt > 0) {
    const uploadedAtText = _formatCloudTimeLabel(backupUploadedAt);
    lines.push(
      uploadedAtText
        ? `闂傚倸鍊风粈渚€骞栭锔藉亱闁告劦鍠栫壕濠氭煙閹规劦鍤欑紒鐙欏洦鐓冮柛婵嗗閳ь剚鎮傞幃姗€鏁愰崶鈺冿紲闂佸搫鍟犻崑鎾寸箾閸忚偐鎳囬柛鈹垮灪閹棃濡搁妷褌绱滈梻浣藉亹閳峰牓宕滈悢灏佹灁妞ゆ帒鍊荤壕钘壝归敐鍫綈妞ゃ儲妫冮弻娑㈠Ω閵堝懎绁柦妯荤箖閵囧嫰骞掑鍫濆帯濡炪倐鏅濋崗姗€寮婚敓鐘茬＜婵☆垵銆€閸嬫挸螖閸愵亞骞?{uploadedAtText}${backupFilename ? ` 闂?${backupFilename}` : ""}`
        : "闂備浇宕甸崰鎰垝鎼淬垺娅犳俊銈呮噹缁犱即鏌涘☉姗堟敾婵炲懐濞€閺岋絽螣閼测晛绗￠梺鎼炲€曢崐鎼佸煘閹达附鍋愰柟缁樺坊閸嬫捇鎳滈悽娈挎锤濡炪倖鐗滈崑鐐烘偂濞戙垺鐓曟い鎰剁秬婢规ê霉濠婂牏鐣洪柡灞稿墲瀵板嫰宕卞Ο鑽ゅ絾闂備焦鎮堕崝搴ㄥ极鐠囪尙鏆︽繛鍡樻尭閻掓椽鏌涢幇鈺佸缂佹劗鍋ゅ娲箹閻愭彃濮风紓浣哄У閸ㄥ灝顕ｉ銏╃叆闁割偆鍠撻崢閬嶆⒑閸︻厼鍔嬫い銊ョ箻瀵娊骞掗弮鍌滐紲濡炪値鍘介崹鐢告倶閿濆洨纾兼い鏃囶潐濞呭﹥銇勯姀锛勨槈閾伙絿鈧懓瀚伴。锔界珶?,
    );
  } else {
    lines.push("闂備浇宕甸崰鎰垝鎼淬垺娅犳俊銈呮噹缁犱即鏌涘☉姗堟敾婵炲懐濞€閺岋絽螣閼测晛绗￠梺鎼炲€曢崐鎼佸煘閹达附鍋愰柟缁樺坊閸嬫捇鎳滈悽娈挎锤濡炪倖鐗滈崑娑氱棯瑜旈弻宥夊传閸曨亞瑙﹂梺纭呮彧闂勫嫰宕曟径鎰厱婵炴垶鐟︾紞鎴︽倵濮橆剦妲告い顓℃硶閹瑰嫰宕崟顓熜為梻浣告憸閸嬫稒鏅舵惔銊ョ疅闁归棿鐒﹂崑瀣煕椤愩倕鏋旀い锔哄劦濮婅櫣鍖栭弴鐔哥彅闂佹椿鍘奸崐鍧楁偘椤旈敮鍋撻敐搴℃灈缂佺姵绋掗妵鍕箳閸℃ぞ澹曟俊鐐€ら崑鍡樼箾閳ь剟鏌″畝瀣М濠碘剝鎮傛俊鐑藉Ψ椤旀槒绻曠紓鍌氬€风欢锟犳偂閸儱鍨傜€规洖娲ら崹婵嬫煃閸濆嫭濯奸柡浣哥У閹便劌螣閸濆嫭鍊柡宥佲偓鏂ユ斀闁绘劕妯婇崵鐔封攽椤旇姤灏﹂柨婵堝仱瀵挳濮€閻橀潧濮?);
  }

  if (backupRestoredAt > 0) {
    const restoredAtText = _formatCloudTimeLabel(backupRestoredAt);
    lines.push(
      restoredAtText
        ? `闂傚倸鍊风粈渚€骞栭锔藉亱闁告劦鍠栫壕濠氭煙閹规劦鍤欑紒鐙欏洦鐓冮柛婵嗗閳ь剚鎮傞幃姗€鏁愰崶鈺冿紲闂佸搫鍟犻崑鎾寸箾閸忚偐鎳囬柛鈹垮灪閹棃濡搁妷褌绱滈梻浣藉亹閳峰牓宕滃☉銏″亗闁绘ê纾粻楣冩倵濞戞瑯鐒介柣顓烆儔閺屾盯濡搁妷褏楔濡炪們鍨哄Λ鍐€佸Δ鍛妞ゆ劑鍊楅弳銏ゆ⒒娓氣偓濞佳呮崲閹烘挸鍨旀い鎾跺€ｉ敐鍡欑瘈婵﹩鍘鹃崣?{restoredAtText}闂傚倸鍊风欢姘焽瑜嶈灋婵°倕鎳庣壕褰掓偡濞嗗繐顏い鈺呮敱閵囧嫰寮崶顭戞缂備礁澧庨崑鐔煎焵椤掆偓缁犲秹宕曟潏鈹惧亾濮樼厧娅嶉柟顔煎槻閳规垹鈧綆鍋勯埀顒勬涧闇夐柨婵嗘噹閺嬨倖绻涢崗鐓庡濞ｅ洤锕幃娆撳箵閹哄棗浜鹃柛顭戝枤閺嗭箓鏌ㄥ┑鍡╂▓闁轰礁绉电换娑㈠幢濡や焦宕抽梻鍌氼槸缁夌懓顫忛搹鍦＜婵☆垰鎼～宀勬⒑閸涘鎴犲垝閹捐鏄ラ柍褜鍓氶妵鍕箳瀹ュ牆鍘￠梺娲诲幖閿曘儳鎹㈠☉銏犵煑濠㈣泛鑻埅鐟邦渻閵堝骸骞戦柛鏂跨焸閿濈偛鈹戠€ｅ灚鏅濋梺闈涚墕濞诧箓宕悧鍫㈢瘈闁汇垽娼ф禒婊勪繆椤愩垻鐒哥€规洘绮岄埞鎴﹀炊閳哄﹥绁俊鐐€栧Λ浣肝涢崟顓燁偨闁绘劗顣介崑鎾荤嵁閸喖濮嶉柣鐘辩劍閻撯€崇暦閹达箑绠婚柡鍌樺劜閺傗偓闂備礁鎲″ú蹇涘礉鐏炲墽顩查柟顖ｇ仈?
        : "闂傚倸鍊风粈渚€骞栭锔藉亱闁告劦鍠栫壕濠氭煙閹规劦鍤欑紒鐙欏洦鐓冮柛婵嗗閳ь剚鎮傞幃姗€鏁愰崶鈺冿紲闂佸搫鍟犻崑鎾寸箾閸忚偐鎳囬柛鈹垮灪閹棃濡搁妷褍濮堕梻浣告啞閸斿繘寮插鍫濈？闁靛濡囩粻楣冨级閸繂鈷旂紒瀣吹缁辨帡顢欓懖鈹垽宕￠柆宥嗙厱婵炴垶锕崝鐔搞亜閳哄啫鍘存鐐寸墱閳ь剚绋掗…鍥╃不濮椻偓濮婂宕ㄩ鍛姺缂備浇椴哥敮鈥愁嚕椤曗偓楠炲鈹戦崼婊呮暰婵犵數鍋涢顓熷垔椤撱垹绐楁俊銈傚亾妞ゆ洏鍎靛畷鐔碱敃椤愩垺鍊梻濠庡亜濞诧箑煤閺嶎厽鍤€闁秆勵殕閳锋垿鎮归崶锝傚亾閸愯尙顔夐梻浣规偠閸斿瞼绱炴繝鍛棨闂備礁鎲￠悷銉┧囬柆宥呯厺闁哄啫鍊甸崑鎾荤嵁閸喖濮庨梺鐟板槻椤戝鐣烽悽鍛婂亹缂備焦顭囬崢鎼佹⒑閸涘﹤濮﹂柛妯兼櫕濞戠敻宕滆閸犳劙鏌℃径濠勪虎缂佺嫏鍛＜闁稿本绋戝ù顔尖攽閿涘嫭鐒挎い锔藉絻闇夐柣娆屽亾闁搞劌鐖煎璇差吋婢跺á銊╂煥閺傚灝鈷旈柣鎾亾濠电姷鏁搁崑娑橆嚕閸洘鍋嬮柡鍥ｆ噰閳ь剨绠撴俊鎼佸Ψ椤旇棄鍏婃俊鐐€栭崝鎴﹀磹濡ゅ懎绠熸い蹇撳閺€浠嬫煟閹邦剙绾фい銉﹀灴閺屾盯骞樼€靛摜鐣虹紓浣稿€圭敮锟犮€佸▎鎾村癄濠㈣泛鐬奸悰顕€鏌ｆ惔锛勭暛闁稿孩澹嗛幏瀣蓟閵夈儳锛涢梺鍦亾閺嬪ジ寮ㄦ禒瀣厱闁哄洦锚婵＄厧霉?,
    );
  }

  if (backupRollbackAt > 0) {
    const rollbackAtText = _formatCloudTimeLabel(backupRollbackAt);
    if (rollbackAtText) {
      lines.push(`闂傚倸鍊风粈渚€骞栭锔藉亱闁告劦鍠栫壕濠氭煙閹规劦鍤欑紒鐙欏洦鐓冮柛婵嗗閳ь剚鎮傞幃姗€鏁愰崶鈺冿紲闂佸搫鍟犻崑鎾寸箾閸忚偐鎳囬柛鈹垮灪閹棃濡搁妷褍濮堕梻浣告啞閸擃剟宕橀妸褌鍠婂┑鐘垫暩婵即宕归悡搴樻灃婵炴垶姘ㄩ惌鎾绘煛婢跺娈繛宸簻閸愨偓閻熸粍绮撻幃锟犲Ψ閿旇棄寮垮┑鈽嗗灠閹碱偊鍩涢弮鍌滅＜?{rollbackAtText}闂傚倸鍊风欢姘焽瑜嶈灋闁哄啫鍊瑰畷?;
    }
  }

  if (needsPostRecoveryBackup) {
    const actionLabel =
      String(dualWrite?.action || "") === "identity-recovery"
        ? "闂傚倸鍊搁崐鎼佲€﹂鍕闁挎洖鍊哥壕濠氭煕瀹€鈧崑娑㈡嚋瑜版帗鐓忛柛顐ｇ箥濡插摜绱掗悩鍐叉诞闁哄本娲濈粻娑㈠即閻戝棌鍋撶仦鍙ョ箚?
        : "闂傚倸鍊风粈渚€骞栭锕€鑸归柡灞诲劚缁€瀣亜閹哄秶璐伴柛鐔插亾闂傚倸鍊烽懗鍫曘€佹繝鍥舵晪闁哄稁鍘肩粣妤佺箾閹寸偞鐨戠紒鎲嬬畵閺屻倕霉鐎ｎ偅鐝栭梺?;
    lines.push(`${actionLabel} 闂備浇顕уù鐑藉箠閹捐绠熼梽鍥Φ閹版澘绀冩い鏃囨娴犵厧顪冮妶鍡楃瑨閻庢凹鍓涚划濠氭晲婢跺鍘甸梺鍝勵槸閻忔繈銆傚畷鍥╃＜闁逞屽墯瀵板嫭绻涢幒鎴犵Ш闁轰焦鍔欏畷銊╊敋閸涱噮妫ょ紓鍌氬€风欢锟犳偂閸儱鍨傜€规洖娲ら崹婵嬫煃閸濆嫭濯奸柡浣哥У閹便劌螣閸濆嫭鍊柡宥佲偓鏂ユ斀闁绘劕妯婇崵鐔封攽椤旇姤灏﹂柛鈹惧亾濡炪倖甯掗崐鎼佸几閺冨倻纾奸柣妯肩帛閺佽京绱掔紒妯笺€掑ù鐙呯畵瀹曠喖鍩℃担鎻掍壕婵°倕鎷嬮弫渚€鏌嶈閸撴氨鎹㈠☉銏犵闁绘劖娼欑喊宥咁渻閵堝骸寮鹃柛妯诲劤鍗遍柟閭﹀厴閺€浠嬫煕閳锯偓閺呮稑鈻撳Ο璁崇箚闁靛牆绻樺顔姐亜閹寸偟鎳囩€规洦鍓熼獮姗€顢欓悾灞藉箺婵犵數濮撮敃銈団偓姘煎幘濞嗐垽宕ｆ径宀€鐦堥梺閫炲苯澧存い銏℃瀹曠厧鈹戦崼顐㈡倯闂備浇顕ч崙鐣岀礊閸℃顩叉繝濠傛－閺夎姤绻濋悽闈浶為柛銊у帶閳绘柨鈽夊Ο蹇旀そ閺佹劖寰勬繝鍛厴闂備線娼ч悧鍡椢涘☉銏犵厺闁哄啫鐗婇悡鍐喐濠婂牆绀堟繛鍡樻尭閻撴繈骞栧ǎ顒€鐏╃紒鐘靛█濮婃椽鏌呴悙鑼跺闁告ê鎽滅槐?;
  }

  statusEl.style.display = lines.length ? "" : "none";
  statusEl.innerHTML = lines.map((line) => `<div>${_escHtml(line)}</div>`).join("");
}

async function _refreshCloudBackupManualUi(settings = _getSettings?.() || {}) {
  const mode = String(settings?.cloudStorageMode || "automatic");
  const rollbackButton = document.getElementById("bme-act-rollback-last-restore");
  if (!rollbackButton) return;

  if (mode !== "manual") {
    rollbackButton.disabled = true;
    rollbackButton.title = "";
    return;
  }

  if (typeof _actionHandlers.getRestoreSafetyStatus !== "function") {
    rollbackButton.disabled = true;
    rollbackButton.title = "";
    return;
  }

  rollbackButton.disabled = true;
  rollbackButton.title = "婵犵數濮甸鏍窗濡ゅ啯宕查柟閭﹀枛缁躲倝鏌﹀Ο渚闁肩増瀵ч妵鍕疀閹惧磭寮稿┑鐐村灟閸ㄥ綊鎮為崹顐犱簻闁圭儤鍨甸鈺呮煢閸愵亜鏋涢柡灞炬礃瀵板嫬鈽夐姀鈽嗏偓宥夋⒑閸︻厼鍘村ù婊冪埣瀵鈽夐姀鈩冩珕闂佸吋浜介崕鎶藉礄閿熺姵鈷戝ù鍏肩懅缁佺兘鏌涢弮鈧崹鐢告偩瀹勬嫈鏃堝川椤撳洠鏅犻弻鏇熷緞濞戞氨鏆犲┑鐐存尰閸旀瑥顫?..";
  try {
    const status = await _actionHandlers.getRestoreSafetyStatus();
    const hasSafety = Boolean(status?.exists);
    rollbackButton.disabled = !hasSafety;
    rollbackButton.title = hasSafety
      ? status?.createdAt
        ? `闂傚倸鍊风粈渚€骞夐敓鐘冲仭妞ゆ牜鍋涢崹鍌炴煛婢跺绱╂繛宸簻閸愨偓閻熸粍绮撻幃锟犲Ψ閿旇棄寮垮┑顔筋殔濡鏅堕鈧弻?${new Date(status.createdAt).toLocaleString()} 闂傚倸鍊烽悞锕傛儑瑜版帒绀夌€光偓閳ь剟鍩€椤掍礁鍤柛妯兼櫕缁骞掑Δ濠冩櫓闂佽姤锚椤﹁京绮ｉ悙鐑樺€垫鐐茬仢閸旀岸鏌熼崘鏌ュ弰鐠侯垶鏌涘☉妯兼憼闁绘挾鍠愭穱濠囶敍濮樺彉铏庨梺缁樻尰閸旀瑩寮诲鍫闂佺绻戠粙鎴︼綖?
        : "闂傚倸鍊风粈渚€骞夐敓鐘冲仭妞ゆ牜鍋涢崹鍌炴煛婢跺绱╂繛宸簻閸愨偓閻熸粍绮撻幃锟犲Ψ閿旇棄寮垮┑顔筋殔濡鏅堕鈧弻锝夊箻閸愭祴鍋撻幖浣哥叀濠㈣埖鍔曠粻鑽ょ磼濞戞粠娼愰柡浣瑰劤椤啴濡堕崱妤€顫岄梺闈涚墛閹倿鎮伴鐣岀懝闁逞屽墯閹便劑鍩€椤掑嫭鐓熸繛鍡楄嫰娴滄儳鈹戦埄鍐ㄧ祷妞ゎ厾鍏樺璇测槈閵忕姷顔掗悗瑙勬礀濞夛箓濡堕崱娆戭啎闂佸壊鍋嗛崰搴ㄦ倶鐎电硶鍋撳▓鍨灓闁轰礁顭烽妴浣肝旈崨顓犲姦濡炪倖宸婚崑鎾绘煥閺囨ê鐏叉鐐达耿椤㈡瑩鎸婃径澶嬬潖闂傚倷鑳堕崢褔骞楀鍫涒偓鍌涚鐎ｎ亞锛?
      : "闂備浇宕甸崰鎰垝鎼淬垺娅犳俊銈呮噹缁犱即鏌涘☉姗堟敾婵炲懐濞€閺岋絽螣閼姐們鍋為梺鍝勭焿缁犳捇寮诲澶婄厸濞达絽鎲″▓鑼磽娴ｅ搫校閻㈩垽绻濆璇测槈濡攱鐎诲┑鈽嗗灥濞咃絾绂掗埡浣叉斀闁绘劖褰冪痪褔鏌ｅΔ浣圭闁炽儻绠撴俊鎼佸Ψ椤旇棄鍏婇梺鍝勵槸閻楀嫰宕濇惔銊ユ辈闁绘绮埛鎴︽偣閸ワ絺鍋撻崘鑼唹闂備焦鎮堕崝宀€绱炴繝鍛棨闂備礁鎼悮顐﹀磿鏉堚晝鐭嗛柛顐熸噰閸嬫捇鐛崹顔煎闂佺懓鍟跨换妤呭Φ閹版澘唯闁冲搫鍊婚崢?;
  } catch (error) {
    console.error("[ST-BME] 闂傚倸鍊风粈渚€骞夐敍鍕殰闁跨喓濮寸紒鈺呮⒑椤掆偓缁夋挳鎷戦悢灏佹斀闁绘ê寮堕幖鎰磼閻樺啿娴柡灞炬礉缁犳盯寮撮悜鍡忓亾鐏炲彞绻嗛柟缁樺俯閻撳ジ鏌熼绛嬫疁闁诡喚鍏橀弻鍥晜閸欘偓绠撳娲川婵犲嫭鍣х紓浣虹帛椤ㄥ牏鍒掔拠娴嬫闁靛繆鏅滈弲婵嬫⒑闂堟稓澧曢柟鍐叉捣閳ь剚鍐荤紞浣割潖閾忓湱纾兼慨妤€妫涢崝鎼佹⒑缁洘娅嗛柣妤冨█瀹曟椽鍩€椤掍降浜滈柟杈剧稻绾埖銇勯敂鑲╃暤闁哄本娲熷畷鍫曞Ω閵壯傛偅闂?", error);
    rollbackButton.disabled = true;
    rollbackButton.title = "闂傚倸鍊峰ù鍥敋閺嶎厼鍌ㄧ憸鐗堝笒閸ㄥ倻鎲搁悧鍫濆惞闁搞儺鍓欓拑鐔兼煏婢跺牆鍔ゆい锔诲弮閹鐛崹顔煎闂佺懓鍟跨换妤呭Φ閹版澘唯闁冲搫鍊婚崢浠嬫⒑閸︻厼浜炬い銊ユ嚇楠炲﹥鎯旈敐鍥ㄥ櫘闂傚倸鍊峰ù鍥敋閺嶎厼绀傛繛鎴欏灪閸婂潡鏌ㄩ弴鐐扮椽濠㈣埖鍔曞婵嬫煛婢跺鐏遍柟鑺ユ礋濮婃椽妫冨☉杈ㄐら梺绋垮瘨閸ㄨ京绮嬪鍡欓檮闁告稑锕ゆ禒?;
  }
}

function _formatBackupManagerTime(timestamp) {
  const value = Number(timestamp);
  if (!Number.isFinite(value) || value <= 0) return "闂傚倸鍊风粈渚€骞栭锔藉亱婵犲﹤瀚々鏌ユ煟閹邦喖鍔嬮柛瀣€块弻銊╂偄閸濆嫅銏㈢磼椤愩垻效闁哄本鐩、鏇㈡晲閸℃瑯妲伴梻?;
  try {
    return new Date(value).toLocaleString();
  } catch {
    return "闂傚倸鍊风粈渚€骞栭锔藉亱婵犲﹤瀚々鏌ユ煟閹邦喖鍔嬮柛瀣€块弻銊╂偄閸濆嫅銏㈢磼椤愩垻效闁哄本鐩、鏇㈡晲閸℃瑯妲伴梻?;
  }
}

function _buildCloudBackupManagerHtml(state = {}) {
  const entries = Array.isArray(state.entries) ? state.entries : [];
  const currentChatId = String(state.currentChatId || "").trim();
  if (state.loading) {
    return `
      <div class="bme-cloud-backup-modal__loading">
        <i class="fa-solid fa-spinner fa-spin"></i> \u6b63\u5728\u8bfb\u53d6\u670d\u52a1\u5668\u5907\u4efd\u5217\u8868...
      </div>
    `;
  }

  if (!entries.length) {
    return `
      <div class="bme-cloud-backup-modal__empty">
        \u670d\u52a1\u5668\u4e0a\u8fd8\u6ca1\u6709 ST-BME \u5907\u4efd\u3002<br />
        \u5148\u5728\u5f53\u524d\u804a\u5929\u70b9\u4e00\u6b21\u201c\u5907\u4efd\u5230\u4e91\u7aef\u201d\u5c31\u4f1a\u51fa\u73b0\u5728\u8fd9\u91cc\u3002
      </div>
    `;
  }

  return entries
    .map((entry) => {
      const chatId = String(entry?.chatId || "").trim();
      const filename = String(entry?.filename || "").trim();
      const isCurrentChat = currentChatId && chatId === currentChatId;
      const backupTime = _formatBackupManagerTime(entry?.backupTime);
      const lastModified = _formatBackupManagerTime(entry?.lastModified);
      const sizeLabel =
        Number.isFinite(Number(entry?.size)) && Number(entry.size) > 0
          ? `${Number(entry.size)} B`
          : "\u672a\u77e5\u5927\u5c0f";
      return `
        <div class="bme-cloud-backup-card ${isCurrentChat ? "is-current-chat" : ""}">
          <div class="bme-cloud-backup-card__top">
            <div class="bme-cloud-backup-card__title">${_escHtml(chatId || "(unknown chat)")}</div>
            ${isCurrentChat ? '<div class="bme-cloud-backup-card__badge"><i class="fa-solid fa-location-dot"></i><span>\u5f53\u524d\u804a\u5929</span></div>' : ""}
          </div>
          <div class="bme-cloud-backup-card__meta">
            <div>Revision: ${_escHtml(String(entry?.revision ?? 0))}</div>
            <div>\u5907\u4efd\u65f6\u95f4: ${_escHtml(backupTime)}</div>
            <div>\u6700\u540e\u4fee\u6539: ${_escHtml(lastModified)}</div>
            <div>\u6587\u4ef6\u5927\u5c0f: ${_escHtml(sizeLabel)}</div>
          </div>
          <div class="bme-cloud-backup-card__filename">${_escHtml(filename)}</div>
          <div class="bme-cloud-backup-card__actions">
            <button
              type="button"
              class="bme-cloud-backup-modal__btn bme-cloud-backup-card__danger"
              data-bme-backup-action="delete"
              data-chat-id="${_escHtml(chatId)}"
              data-filename="${_escHtml(filename)}"
              ${state.busy ? "disabled" : ""}
            >
              <i class="fa-solid fa-trash-can"></i>
              <span>\u5220\u9664\u5907\u4efd</span>
            </button>
          </div>
        </div>
      `;
    })
    .join("");
}
async function _openServerBackupManagerModal() {
  if (typeof _actionHandlers.manageServerBackups !== "function") {
    toastr.info("\u5f53\u524d\u8fd0\u884c\u65f6\u6ca1\u6709\u63a5\u5165\u670d\u52a1\u5668\u5907\u4efd\u7ba1\u7406\u5165\u53e3", "ST-BME");
    return { handledToast: true, skipDashboardRefresh: true };
  }

  _ensureCloudBackupManagerStyles();
  const { callGenericPopup, POPUP_TYPE } = await getPopupRuntime();
  const state = {
    loading: true,
    busy: false,
    entries: [],
    currentChatId: "",
  };

  const container = document.createElement("div");
  container.className = "bme-cloud-backup-modal";
  container.innerHTML = `
    <div class="bme-cloud-backup-modal__header">
      <div>
        <div class="bme-cloud-backup-modal__title">\u7ba1\u7406\u670d\u52a1\u5668\u5907\u4efd</div>
        <div class="bme-cloud-backup-modal__subtitle">
          \u8fd9\u91cc\u5c55\u793a\u7684\u662f\u624b\u52a8\u5907\u4efd\u6587\u4ef6\uff0c\u4e0d\u4f1a\u628a\u81ea\u52a8\u540c\u6b65\u955c\u50cf\u6df7\u8fdb\u6765\u3002<br />
          \u5220\u9664\u64cd\u4f5c\u53ea\u5f71\u54cd\u4e91\u7aef\u5907\u4efd\uff0c\u4e0d\u4f1a\u6539\u52a8\u5f53\u524d\u8bbe\u5907\u7684\u672c\u5730 IndexedDB\u3002
        </div>
      </div>
      <div class="bme-cloud-backup-modal__tools">
        <button type="button" class="bme-cloud-backup-modal__btn" data-bme-backup-action="refresh">
          <i class="fa-solid fa-rotate"></i>
          <span>\u5237\u65b0\u5217\u8868</span>
        </button>
      </div>
    </div>
    <div class="bme-cloud-backup-modal__list"></div>
  `;

  const listEl = container.querySelector(".bme-cloud-backup-modal__list");
  const render = () => {
    if (!listEl) return;
    listEl.innerHTML = _buildCloudBackupManagerHtml(state);
    const refreshBtn = container.querySelector('[data-bme-backup-action="refresh"]');
    if (refreshBtn) refreshBtn.disabled = Boolean(state.busy || state.loading);
  };

  const refreshEntries = async ({ showToast = false } = {}) => {
    state.loading = true;
    render();
    try {
      const result = await _actionHandlers.manageServerBackups();
      state.entries = Array.isArray(result?.entries) ? result.entries : [];
      state.currentChatId = String(result?.currentChatId || "").trim();
      if (showToast) {
        toastr.success("\u670d\u52a1\u5668\u5907\u4efd\u5217\u8868\u5df2\u5237\u65b0", "ST-BME");
      }
    } catch (error) {
      console.error("[ST-BME] failed to load server backups:", error);
      toastr.error(`\u8bfb\u53d6\u670d\u52a1\u5668\u5907\u4efd\u5931\u8d25: ${error?.message || error}`, "ST-BME");
    } finally {
      state.loading = false;
      render();
    }
  };

  const deleteEntry = async (chatId, filename) => {
    if (typeof _actionHandlers.deleteServerBackupEntry !== "function") {
      toastr.error("\u5f53\u524d\u8fd0\u884c\u65f6\u6ca1\u6709\u63a5\u5165\u5220\u9664\u670d\u52a1\u5668\u5907\u4efd\u5165\u53e3", "ST-BME");
      return;
    }

    if (!globalThis.confirm?.(`\u786e\u5b9a\u8981\u5220\u9664\u670d\u52a1\u5668\u5907\u4efd ${filename} \u5417\uff1f\u6b64\u64cd\u4f5c\u4e0d\u53ef\u64a4\u9500\u3002`)) {
      return;
    }

    state.busy = true;
    render();
    try {
      const result = await _actionHandlers.deleteServerBackupEntry({
        chatId,
        filename,
      });
      if (!result?.deleted) {
        const message =
          result?.reason === "delete-backup-manifest-error"
            ? result?.backupDeleted
              ? "\u5907\u4efd\u6587\u4ef6\u5df2\u5220\u9664\uff0c\u4f46\u670d\u52a1\u5668\u5907\u4efd\u6e05\u5355\u66f4\u65b0\u5931\u8d25\uff0c\u8bf7\u7a0d\u540e\u91cd\u8bd5"
              : "\u670d\u52a1\u5668\u5907\u4efd\u6e05\u5355\u66f4\u65b0\u5931\u8d25\uff0c\u8bf7\u7a0d\u540e\u91cd\u8bd5"
            : `\u5220\u9664\u5931\u8d25: ${result?.error?.message || result?.reason || "\u672a\u77e5\u539f\u56e0"}`;
        toastr.error(message, "ST-BME");
        return;
      }
      toastr.success(`\u5df2\u5220\u9664\u670d\u52a1\u5668\u5907\u4efd\uff1a${filename}`, "ST-BME");
      await refreshEntries();
    } catch (error) {
      console.error("[ST-BME] failed to delete server backup:", error);
      toastr.error(`\u5220\u9664\u5931\u8d25: ${error?.message || error}`, "ST-BME");
    } finally {
      state.busy = false;
      render();
      void _refreshCloudBackupManualUi();
    }
  };

  container.addEventListener("click", async (event) => {
    const button = event.target.closest?.("[data-bme-backup-action]");
    if (!button || button.disabled) return;
    const action = String(button.dataset.bmeBackupAction || "");
    if (action === "refresh") {
      await refreshEntries({ showToast: true });
      return;
    }
    if (action === "delete") {
      await deleteEntry(
        String(button.dataset.chatId || "").trim(),
        String(button.dataset.filename || "").trim(),
      );
    }
  });

  await refreshEntries();
  await callGenericPopup(container, POPUP_TYPE.TEXT, "", {
    okButton: "\u5173\u95ed",
    wide: true,
    large: true,
    allowVerticalScrolling: true,
  });
  return { handledToast: true, skipDashboardRefresh: true };
}
  if (options.refreshPrompts) _refreshPromptCardStates(settings);
  if (options.refreshTaskWorkspace) _refreshTaskProfileWorkspace(settings);
  if (options.refreshTheme)
    _highlightThemeChoice(settings.panelTheme || "crimson");
  return settings;
}

function _normalizeLlmPresetSettings(settings = _getSettings?.() || {}) {
  const normalized = sanitizeLlmPresetSettings(settings);

  if (!normalized.changed) {
    return settings;
  }

  return _patchSettings({
    llmPresets: normalized.presets,
    llmActivePreset: normalized.activePreset,
  }, {
    refreshTaskWorkspace: true,
  });
}

function _resolveAndPersistActiveLlmPreset(settings = _getSettings?.() || {}) {
  const normalizedSettings = _normalizeLlmPresetSettings(settings);
  const resolvedActivePreset = resolveActiveLlmPresetName(normalizedSettings);
  if (
    resolvedActivePreset !==
    String(normalizedSettings?.llmActivePreset || "")
  ) {
    return _patchSettings({ llmActivePreset: resolvedActivePreset });
  }
  return normalizedSettings;
}

function _getLlmConfigInputSnapshot() {
  const settings = _getSettings?.() || {};
  return {
    llmApiUrl: String(
      document.getElementById("bme-setting-llm-url")?.value ?? settings.llmApiUrl ?? "",
    ).trim(),
    llmApiKey: String(
      document.getElementById("bme-setting-llm-key")?.value ?? settings.llmApiKey ?? "",
    ).trim(),
    llmModel: String(
      document.getElementById("bme-setting-llm-model")?.value ?? settings.llmModel ?? "",
    ).trim(),
  };
}

function _populateLlmPresetSelect(presets = {}, activePreset = "") {
  const select = document.getElementById("bme-llm-preset-select");
  if (!select) return;

  while (select.options.length > 1) {
    select.remove(1);
  }

  Object.keys(presets)
    .sort((left, right) => left.localeCompare(right, "zh-Hans-CN"))
    .forEach((name) => {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name;
      select.appendChild(option);
    });

  select.value = activePreset || "";
}

function _syncLlmPresetControls(activePreset = "") {
  const select = document.getElementById("bme-llm-preset-select");
  if (select) {
    select.value = activePreset || "";
  }

  const deleteBtn = document.getElementById("bme-llm-preset-delete");
  if (deleteBtn) {
    deleteBtn.disabled = !activePreset;
    deleteBtn.title = activePreset ? "闂傚倸鍊风粈渚€骞夐敍鍕殰闁绘劕顕粻楣冩煃瑜滈崜姘辨崲濞戙垹宸濇い鎾跺枎閺€顓㈡⒑闂堟稒澶勯柛鏃€鐟╅悰顔碱潨閳ь剙鐣峰Ο渚晠妞ゆ梻鏅埀顒夊亝缁绘繄鍠婂Ο娲绘綉闂佸壊鐓堟禍顏勭暦濠婂啠鏀介柛鈾€鏅濋崬? : "闂傚倸鍊风粈浣虹礊婵犲偆鐒界憸鏃堛€侀弽顓炲窛妞ゆ棁妫勫鍧楁⒑鐎圭姵銆冪紒鎻掋偢閹垽鎮℃惔锝勭礈闁诲氦顫夊ú鏍洪妸鈹库偓渚€宕ㄩ鍓ь啎闂佺懓顕崑鐐典焊椤撶喆浜滈柟瀛樼箖椤ャ垽鏌熼妤€浜鹃梻浣告啞缁嬫帒顭囧▎鎴斿亾濮橆剦妲告い顓℃硶閹瑰嫰鎮弶鎴滅矗闂佽崵濮抽悞锕傛偂閿熺姴钃熸繛鎴欏灩缁犳娊鏌￠崒姘辨皑闁哄鎳庨埞鎴︽倷閸欏娅ｉ梻浣稿簻缂嶄線鐛崱娑樼妞ゆ棁鍋愰ˇ鏉款渻閵堝棗鐏╅柛鐘茬Ф濞嗐垹顫濋澶婃?;
  }
}

function _clearFetchedLlmModels() {
  fetchedMemoryLLMModels.length = 0;
  const modelSelect = document.getElementById("bme-select-llm-model");
  if (!modelSelect) return;
  while (modelSelect.options.length > 1) {
    modelSelect.remove(1);
  }
  modelSelect.value = "";
  modelSelect.style.display = "none";
}

function _markLlmPresetDirty(options = {}) {
  if (options.clearFetchedModels) {
    _clearFetchedLlmModels();
  }

  const settings = _resolveAndPersistActiveLlmPreset(_getSettings?.() || {});
  _syncLlmPresetControls(String(settings?.llmActivePreset || ""));
}

function _highlightThemeChoice(themeName) {
  if (!panelEl) return;
  panelEl.querySelectorAll(".bme-theme-option").forEach((opt) => {
    opt.classList.toggle("active", opt.dataset.theme === themeName);
  });
  panelEl.querySelectorAll(".bme-theme-card").forEach((card) => {
    card.classList.toggle("active", card.dataset.theme === themeName);
  });
}

function _refreshGuardedConfigStates(settings = _getSettings?.() || {}) {
  if (!panelEl) return;
  panelEl.querySelectorAll(".bme-guarded-card").forEach((card) => {
    const guardKeys = String(card.dataset.guardSettings || "")
      .split(",")
      .map((key) => key.trim())
      .filter(Boolean);
    const enabled = guardKeys.every((key) => Boolean(settings[key]));
    card.classList.toggle("is-disabled", !enabled);
    const note = card.querySelector(".bme-config-guard-note");
    note?.classList.toggle("visible", !enabled);
    card
      .querySelectorAll("input, select, textarea, button")
      .forEach((element) => {
        element.disabled = !enabled;
      });
  });
}

function _refreshStageCardStates(settings = _getSettings?.() || {}) {
  if (!panelEl) return;
  panelEl.querySelectorAll(".bme-stage-card").forEach((card) => {
    const toggleId = card.dataset.stageToggleId;
    const toggle = toggleId ? document.getElementById(toggleId) : null;
    const cardDisabled = card.classList.contains("is-disabled");
    const stageEnabled =
      toggleId === "bme-setting-recall-llm"
        ? (settings.recallEnableLLM ?? true)
        : toggle
          ? Boolean(toggle.checked)
          : true;

    card.classList.toggle("stage-disabled", !cardDisabled && !stageEnabled);
    card.querySelectorAll(".bme-stage-param").forEach((section) => {
      section
        .querySelectorAll("input, select, textarea, button")
        .forEach((element) => {
          element.disabled = cardDisabled || !stageEnabled;
        });
    });
  });
}

function _refreshFetchedModelSelects(settings = _getSettings?.() || {}) {
  _renderFetchedModelOptions(
    "bme-select-llm-model",
    fetchedMemoryLLMModels,
    settings.llmModel || "",
  );
  _renderFetchedModelOptions(
    "bme-select-embed-backend-model",
    fetchedBackendEmbeddingModels,
    settings.embeddingBackendModel || "",
  );
  _renderFetchedModelOptions(
    "bme-select-embed-direct-model",
    fetchedDirectEmbeddingModels,
    settings.embeddingModel || "",
  );
}

function _renderFetchedModelOptions(selectId, models, currentValue = "") {
  const select = document.getElementById(selectId);
  if (!select) return;

  const normalized = Array.isArray(models) ? models : [];
  select.innerHTML = "";

  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = normalized.length
    ? "濠电姷鏁搁崑娑㈩敋椤撶喐鍙忛悗鐢电《閸嬫挸鈽夐幒鎾寸彆闂佸憡甯掗敃銈囧弲濡炪倕绻愮€氼噣鎮￠幋锔解拺闁告繂瀚埢澶愭煕鐎ｎ亝顥滈柍缁樻婵偓闁靛牆妫涢崢鎼佹煟鎼搭垳绉甸柛瀣閹矂宕卞☉娆戝幘闂佸壊鐓堥崑鍕倶閹绢喗鐓涢悘鐐跺Г閸ｈ櫣鈧灚婢樼€氼噣鍩€椤掑﹦绉靛ù婊嗗煐缁傛帡寮堕幋鏃€鏂€闂佸疇妫勫Λ妤呮倶濞嗘挻鐓冪憸婊堝礈濞嗘垵顥氭い鎾卞灩閻?
    : "闂傚倸鍊风粈渚€骞栭鈶芥稑螖閸涱厾锛欓梺鑽ゅ枑鐎氬牆鈽夐姀鐘栄囨煕濠娾偓缁€渚€寮查悩缁樷拺闁告稑锕﹂幊鍐┿亜閿旇鐏︽い銏℃尭閳诲酣骞樼€电骞堟繝鐢靛仜濡瑩宕濆Δ浣规珷妞ゆ帒瀚崵澶愭煃閸濆嫭鍣洪柣?;
  select.appendChild(placeholder);

  normalized.forEach((model) => {
    const option = document.createElement("option");
    option.value = String(model?.id || "");
    option.textContent = String(model?.label || model?.id || "");
    select.appendChild(option);
  });

  if (
    currentValue &&
    normalized.some((model) => String(model?.id || "") === String(currentValue))
  ) {
    select.value = String(currentValue);
  } else {
    select.value = "";
  }

  select.style.display = normalized.length > 0 ? "" : "none";
}

function _refreshPromptCardStates(settings = _getSettings?.() || {}) {
  if (!panelEl) return;
  panelEl.querySelectorAll(".bme-prompt-card").forEach((card) => {
    const settingKey = card.dataset.settingKey;
    const statusEl = card.querySelector(".bme-prompt-status");
    const resetButton = card.querySelector(".bme-prompt-reset");
    const isCustom = Boolean(String(settings?.[settingKey] || "").trim());
    card.classList.toggle("is-custom", isCustom);
    if (statusEl) {
      statusEl.textContent = isCustom ? "闂備浇顕у锕傦綖婢舵劖鍋ら柡鍥╁С閻掑﹥銇勮箛鎾跺闁告俺顫夌换婵囩節閸屾稑娅濋梺绋款儐閹搁箖骞夐幘顔肩妞ゆ挾濮磋ぐ搴ｇ磽? : "濠电姵顔栭崰妤冩暜濡ゅ啰鐭欓柟鐑樸仜閳ь剨绠撳畷濂稿Ψ椤旇姤娅?;
      statusEl.classList.toggle("is-custom", isCustom);
    }
    if (resetButton) {
      resetButton.disabled = !isCustom;
    }
  });
}

function _toggleEmbedFields(mode) {
  const backendEl = document.getElementById("bme-embed-backend-fields");
  const directEl = document.getElementById("bme-embed-direct-fields");
  if (backendEl) backendEl.style.display = mode === "backend" ? "" : "none";
  if (directEl) directEl.style.display = mode === "direct" ? "" : "none";
}

function _setInputValue(id, value) {
  const el = document.getElementById(id);
  if (el && el.value !== String(value ?? "")) {
    el.value = String(value ?? "");
  }
}

function _setCheckboxValue(id, checked) {
  const el = document.getElementById(id);
  if (el) {
    el.checked = Boolean(checked);
  }
}

function _parseOptionalInt(value) {
  const parsed = Number.parseInt(String(value ?? "").trim(), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function _escHtml(str) {
  const div = document.createElement("div");
  div.textContent = String(str ?? "");
  return div.innerHTML;
}

function _escAttr(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function _safeCssToken(value, fallback = "unknown") {
  const token = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return token || fallback;
}

function _matchesMemoryFilter(node, filter = "all") {
  if (!node || filter === "all") return true;
  const scope = normalizeMemoryScope(node.scope);
  switch (filter) {
    case "scope:objective":
      return scope.layer === "objective";
    case "scope:characterPov":
      return scope.layer === "pov" && scope.ownerType === "character";
    case "scope:userPov":
      return scope.layer === "pov" && scope.ownerType === "user";
    default:
      return node.type === filter;
  }
}

function _buildScopeMetaText(node) {
  const scope = normalizeMemoryScope(node?.scope);
  const parts = [];
  if (scope.layer === "pov") {
    parts.push(
      `${scope.ownerType === "user" ? "闂傚倸鍊烽悞锕€顪冮崹顕呯劷闁秆勵殔缁€澶屸偓骞垮劚椤︻垶寮?POV" : "闂傚倷娴囧畷鐢稿窗閹扮増鍋￠柨鏃傚亾閺嗘粓鏌ｉ弬鎸庢喐闁?POV"}: ${scope.ownerName || scope.ownerId || "闂傚倸鍊风粈渚€骞栭锔藉亱婵犲﹤瀚々鍙夌節婵犲倻澧曠紒鐘靛█閺屻劑鎮㈤崫鍕戙垽鎮?}`,
    );
  }
  const regionLine = buildRegionLine(scope);
  if (regionLine) parts.push(regionLine);
  const storyTime = describeNodeStoryTime(node);
  if (storyTime) parts.push(`闂傚倸鍊风粈渚€骞夐敓鐘茬闁糕剝绋戠粈瀣亜閹扳晛鐏╂い銉ョЧ濮婄粯鎷呴崨濠冨創闂佸摜鍣ラ崑濠囧箖閵夆晜鍋傛? ${storyTime}`);
  return parts.join(" 闂?");
}

/** 闂傚倷娴囧畷鍨叏閹惰姤鍊块柨鏇楀亾妞ゎ厼鐏濊灒闁稿繒鍘ф惔濠囨⒑缁嬭法鐏遍柛瀣〒缁牓宕卞Ο鍦畾闂侀潧鐗嗛幊搴敂閵夆晜鐓冪憸婊堝礈濞嗘挸鐤柟娈垮枛閸ㄦ繈鏌涢…鎴濅簻缂佸墎鍋ら幃妤呮晲鎼存繄鏁栧┑鈽嗗灠鐎氭澘顫忓ú顏勪紶闁告洦鍘滈姀锛勭闁哄鍨甸顐ｄ繆閸欏濮堥悗浣冨亹閳ь剚绋掗…鍥礉閸洘鈷戦柛鎾瑰皺閸樻盯鏌涢悩宕囧⒈闁轰緡鍣ｉ幖褰掝敃閵堝浂鍟庨梻浣告贡閳峰牓宕㈡總绋垮嚑闁靛牆顦伴悡鏇㈡倵閿濆懎顣抽柟顔笺偢閺岀喐顦版惔鈾€鏋呭銈冨灪缁嬫垿锝炲┑瀣垫晣婵炴垶鐟ф禍鐐烘⒒閸屾瑨鍏岄柟铏崌閹ê顫濈捄铏诡唶闂佸綊妫跨粈渚€宕?9.499999999999998 */
function _formatMemoryMetricNumber(value, { fallback = 0, maxFrac = 2 } = {}) {
  const x =
    value === undefined || value === null || value === ""
      ? Number(fallback)
      : Number(value);
  if (!Number.isFinite(x)) return "闂?;
  const rounded = Number.parseFloat(x.toFixed(maxFrac));
  if (Object.is(rounded, -0)) return "0";
  return String(rounded);
}

function _formatMemoryInt(value, fallback = 0) {
  const x =
    value === undefined || value === null || value === ""
      ? Number(fallback)
      : Number(value);
  if (!Number.isFinite(x)) return "闂?;
  return String(Math.trunc(x));
}

function _typeLabel(type) {
  const map = {
    character: "闂傚倷娴囧畷鐢稿窗閹扮増鍋￠柨鏃傚亾閺嗘粓鏌ｉ弬鎸庢喐闁?,
    event: "濠电姷鏁搁崑娑㈡偤閵娧冨灊鐎光偓閸曞灚鏅為梺鍛婃处閸嬧偓闁?,
    location: "闂傚倸鍊风欢姘焽婵犳碍鈷旈柛鏇ㄥ墰閻濆爼鏌涢埄鍐槈缁?,
    thread: "濠电姷鏁搁崑鐐哄垂閸洖绠插ù锝呮憸閺嗭箓鏌ｉ姀銏╃劸闁?,
    rule: "闂傚倷娴囧畷鐢稿窗閹扮増鍋￠柕澹偓閸嬫挸顫濋悡搴♀拫閻?,
    synopsis: "婵犵數濮甸鏍窗濡ゅ啯鏆滈柟鐑橆殔绾剧懓霉閻樺樊鍎嶉柍?,
    reflection: "闂傚倸鍊风粈渚€骞夐敓鐘冲仭闁靛／鍛厠闂佹眹鍨婚…鍫ユ倿?,
    pov_memory: "濠电姷鏁搁崑鐐哄垂閸洖绠伴悹鍥у棘閿濆绠虫俊銈咁儑缁嬪繘姊洪幖鐐插姉闁哄懏绮嶉崚濠冪附閸涘﹦鍘告繝銏ｆ硾鐎涒晝娑甸崜浣虹＜?,
  };
  return map[type] || type || "闂?;
}

function _getNodeSnippet(node) {
  const fields = node.fields || {};
  const storyTime = describeNodeStoryTime(node);
  if (fields.summary) return fields.summary;
  if (fields.state) return fields.state;
  if (fields.constraint) return fields.constraint;
  if (fields.insight) return fields.insight;
  if (fields.traits) return fields.traits;
  if (storyTime) return `闂傚倸鍊风粈渚€骞夐敓鐘茬闁糕剝绋戠粈瀣亜閹扳晛鐏╂い銉ョЧ濮婄粯鎷呴崨濠冨創闂佸摜鍣ラ崑濠囧箖閵夆晜鍋傛? ${storyTime}`;

  const entries = Object.entries(fields).filter(
    ([key]) => !["name", "title", "summary", "embedding"].includes(key),
  );
  if (entries.length > 0) {
    return entries
      .slice(0, 2)
      .map(([key, value]) => `${key}: ${value}`)
      .join("; ");
  }
  return "闂傚倸鍊风粈渚€骞栭锕€鐤柣妤€鐗婇崣蹇涙煙鐟欏嫬濮堥柨娑樺€垮缁樻媴娓氼垳鍔哥紓浣虹帛閸旀瑩鐛繝鍐╁劅闁靛绠戞禒閬嶆偡濠婂啰效闁?;
}

function _isMobile() {
  return window.innerWidth <= 768;
}



