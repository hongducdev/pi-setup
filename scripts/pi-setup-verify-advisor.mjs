#!/usr/bin/env node
/**
 * pi-setup-verify-advisor.mjs — kiểm tra `advisor.json` theo ĐÚNG config schema
 * của `pi-advisor-flow` đang cài, thay vì tin vào tên key suy đoán.
 *
 * Vì sao cần: `pi-advisor-flow` KHÔNG báo lỗi khi gặp key lạ — nó giữ nguyên key
 * đó trong file rồi chỉ notify một dòng "contains unrecognized key(s) ... They
 * were preserved but ignored", và giá trị của key đó KHÔNG có hiệu lực. Nghĩa là
 * một key viết sai tên (hoặc lấy từ tên biến nội bộ trong bundle) trông như đã
 * cấu hình mà thực tế không có tác dụng gì.
 *
 * Script trích `CONFIG_SCHEMA` từ chính bundle đang cài rồi mô phỏng hai kiểm tra
 * mà extension chạy lúc load:
 *
 *   - unknownConfigKeys()  key không có trong CONFIG_SCHEMA  -> warning, bị ignore
 *   - validate*Values()    sai type / ngoài enum             -> lỗi ở lần gọi advisor
 *
 * Dùng:
 *   node scripts/pi-setup-verify-advisor.mjs                 # chỉ file trong repo
 *   node scripts/pi-setup-verify-advisor.mjs --live          # + ~/.pi/agent/advisor.json
 *   node scripts/pi-setup-verify-advisor.mjs --file /path/khac.json
 *   node scripts/pi-setup-verify-advisor.mjs --pkg <đường dẫn dist/index.js>
 *
 * Exit code: 0 = sạch · 1 = config sai (key lạ, sai type, ngoài enum, JSON hỏng,
 * thiếu file, snapshot lệch bản đang chạy) · 2 = lỗi môi trường (không thấy bundle
 * pi-advisor-flow, bundle đổi định dạng, tham số sai) — để phân biệt được
 * "config sai" với "máy chưa cài".
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");
const PKG_ENTRY = path.join("npm", "node_modules", "pi-advisor-flow", "dist", "index.js");

/** pi cài package vào cây npm riêng của config dir. */
function agentDir() {
	return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

function pkgCandidates() {
	return [
		path.join(agentDir(), PKG_ENTRY),
		path.join(os.homedir(), ".pi", "agent", PKG_ENTRY),
	];
}

const say = (line = "") => process.stdout.write(`${line}\n`);
const complain = (line = "") => process.stderr.write(`${line}\n`);

function usage() {
	say(`Dùng: node scripts/pi-setup-verify-advisor.mjs [tùy chọn]

  --file PATH   File advisor.json cần kiểm tra (lặp lại được). Mặc định: <repo>/config/advisor.json
  --live        Kiểm tra thêm file đang có hiệu lực: $PI_CODING_AGENT_DIR/advisor.json
                (mặc định ~/.pi/agent/advisor.json)
  --pkg PATH    Đường dẫn dist/index.js của pi-advisor-flow (mặc định: tự dò trong ~/.pi/agent/npm)
  -h, --help    In hướng dẫn này

Exit: 0 sạch · 1 config sai (kể cả JSON hỏng/thiếu file) · 2 lỗi môi trường`);
}

// --- đọc tham số ---
const files = [];
let live = false;
let pkgPath = null;
for (let i = 2; i < process.argv.length; i++) {
	const arg = process.argv[i];
	if (arg === "-h" || arg === "--help") {
		usage();
		process.exit(0);
	} else if (arg === "--live") {
		live = true;
	} else if (arg === "--file" || arg === "--pkg") {
		const value = process.argv[++i];
		if (!value) {
			complain(`✗ ${arg} cần tham số PATH`);
			process.exit(2);
		}
		if (arg === "--file") files.push(value);
		else pkgPath = value;
	} else {
		usage();
		complain(`\n✗ tham số không hợp lệ: ${arg}`);
		process.exit(2);
	}
}

const targets = [...files];
if (targets.length === 0) targets.push(path.join(REPO_ROOT, "config", "advisor.json"));
if (live) targets.push(path.join(agentDir(), "advisor.json"));

// --- tìm bundle pi-advisor-flow ---
if (pkgPath === null) {
	pkgPath = pkgCandidates().find((candidate) => fs.existsSync(candidate)) ?? null;
	if (pkgPath === null) {
		complain("✗ không tìm thấy bundle pi-advisor-flow. Đã thử:");
		for (const candidate of pkgCandidates()) complain(`   ${candidate}`);
		complain("  → cài package trước (pi tự cài khi khởi động), hoặc chỉ định --pkg <dist/index.js>");
		process.exit(2);
	}
}
let source;
try {
	source = fs.readFileSync(pkgPath, "utf8");
} catch (error) {
	complain(`✗ không đọc được ${pkgPath}: ${error.message}`);
	process.exit(2);
}

// --- tiện ích parse: bỏ qua string literal để không đếm ngoặc trong string ---
function skipString(text, index) {
	const quote = text[index];
	let i = index + 1;
	while (i < text.length) {
		if (text[i] === "\\") {
			i += 2;
			continue;
		}
		if (text[i] === quote) return i + 1;
		i++;
	}
	return i;
}

/** Cắt đoạn từ ngoặc mở tới ngoặc đóng khớp mức, có ý thức về string. */
function sliceBalanced(text, openIndex, openChar, closeChar) {
	let depth = 0;
	for (let i = openIndex; i < text.length; i++) {
		const ch = text[i];
		if (ch === '"' || ch === "'" || ch === "`") {
			i = skipString(text, i) - 1;
			continue;
		}
		if (ch === openChar) depth++;
		else if (ch === closeChar) {
			depth--;
			if (depth === 0) return text.slice(openIndex, i + 1);
		}
	}
	return null;
}

/** Mảng string của một const: `var GATE_FAILURE_MODES = ["a", "b"];` */
function constStringArray(text, identifier) {
	const declaration = new RegExp(`var\\s+${identifier}\\s*=\\s*\\[`).exec(text);
	if (!declaration) return null;
	const literal = sliceBalanced(text, text.indexOf("[", declaration.index), "[", "]");
	if (!literal) return null;
	return [...literal.matchAll(/"([^"]*)"/g)].map((match) => match[1]);
}

/** Đọc `type:` / `accepted:` trong object giá trị của một entry. Trả index mới, hoặc -1. */
function readProperty(region, index, entry) {
	const type = /^type\s*:\s*"([a-z]+)"/.exec(region.slice(index));
	if (type) {
		entry.type = type[1];
		return index + type[0].length;
	}
	const accepted = /^accepted\s*:\s*/.exec(region.slice(index));
	if (!accepted) return -1;
	const rest = region.slice(index + accepted[0].length);
	const literal = /^"([^"]*)"/.exec(rest);
	const reference = /^([A-Za-z_$][\w$]*)\s*\.\s*join\s*\(/.exec(rest);
	if (literal) {
		entry.acceptedRaw = literal[1];
		return index + accepted[0].length + literal[0].length;
	}
	if (reference) {
		entry.acceptedRaw = reference[1];
		return index + accepted[0].length + reference[0].length;
	}
	return index + accepted[0].length;
}

/**
 * Trích CONFIG_SCHEMA: key -> { type, acceptedRaw, values }.
 * Entry được chốt khi object giá trị của nó ĐÓNG (depth 2 -> 1), không phải lúc
 * mở, để type/accepted bên trong đã kịp đọc.
 */
function extractSchema(text) {
	const declarationAt = text.indexOf("var CONFIG_SCHEMA = {");
	if (declarationAt < 0) throw new Error("không tìm thấy `var CONFIG_SCHEMA = {` trong bundle");
	const region = sliceBalanced(text, text.indexOf("{", declarationAt), "{", "}");
	if (!region) throw new Error("CONFIG_SCHEMA không đóng ngoặc — bundle đổi định dạng?");

	const schema = new Map();
	let depth = 0;
	let key = null;
	let entry = null;

	for (let i = 0; i < region.length; ) {
		const ch = region[i];
		if (ch === '"' || ch === "'" || ch === "`") {
			i = skipString(region, i);
			continue;
		}
		if (ch === "{") {
			depth++;
			i++;
			continue;
		}
		if (ch === "}") {
			if (depth === 2 && key !== null && entry !== null) {
				schema.set(key, entry);
				key = null;
				entry = null;
			}
			depth--;
			i++;
			continue;
		}
		if (depth === 1) {
			const name = /^([A-Za-z_$][\w$]*)\s*:/.exec(region.slice(i));
			if (name) {
				key = name[1];
				entry = { type: "?", acceptedRaw: null, values: null };
				i += name[0].length;
				continue;
			}
		} else if (depth === 2 && entry !== null) {
			const next = readProperty(region, i, entry);
			if (next >= 0) {
				i = next;
				continue;
			}
		}
		i++;
	}

	// enum: `accepted: IDENT.join(", ")` -> tra mảng string của IDENT; hoặc chuỗi "a, b"
	for (const value of schema.values()) {
		if (value.type !== "enum" || !value.acceptedRaw) continue;
		value.values = value.acceptedRaw.includes(",")
			? value.acceptedRaw.split(/\s*,\s*/).filter(Boolean)
			: constStringArray(text, value.acceptedRaw);
	}
	return schema;
}

let schema;
try {
	schema = extractSchema(source);
} catch (error) {
	complain(`✗ ${error.message}`);
	process.exit(2);
}
if (schema.size === 0) {
	complain("✗ trích được 0 key từ CONFIG_SCHEMA — bundle đổi định dạng, script cần cập nhật");
	process.exit(2);
}

const JS_TYPE = { string: "string", boolean: "boolean", number: "number", object: "object" };

function jsTypeOf(value) {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	return typeof value;
}

/** So một file với schema. Trả về danh sách vấn đề (rỗng = hợp lệ). */
function checkConfig(config, schemaMap) {
	const issues = [];
	for (const name of Object.keys(config)) {
		if (!schemaMap.has(name)) {
			issues.push(`key lạ "${name}" — pi-advisor-flow sẽ bỏ qua (warning "unrecognized key(s)")`);
		}
	}
	for (const [name, value] of Object.entries(config)) {
		const spec = schemaMap.get(name);
		if (!spec) continue;
		if (spec.type === "enum") {
			if (spec.values && !spec.values.includes(value)) {
				issues.push(`"${name}" ngoài enum: phải là ${spec.values.map((v) => JSON.stringify(v)).join(" · ")}`);
			}
			continue;
		}
		if (spec.type !== "?" && JS_TYPE[spec.type] !== jsTypeOf(value)) {
			issues.push(`"${name}" sai type: schema cần ${spec.type}, file có ${jsTypeOf(value)}`);
			continue;
		}
		const wantsModelRef = spec.type === "string" && (spec.acceptedRaw ?? "").includes("provider/model");
		if (wantsModelRef && !/^\S+\/\S+$/.test(String(value))) {
			issues.push(`"${name}" phải có dạng provider/model, file có ${JSON.stringify(value)}`);
		}
	}
	return issues;
}

// --- kiểm tra từng file ---
let problems = 0;
let checked = 0;

for (const file of targets) {
	if (!fs.existsSync(file)) {
		complain(`✗ không thấy file: ${file}`);
		problems++;
		continue;
	}
	let config;
	try {
		config = JSON.parse(fs.readFileSync(file, "utf8"));
	} catch (error) {
		complain(`✗ JSON không hợp lệ trong ${file}: ${error.message}`);
		problems++;
		continue;
	}
	if (config === null || typeof config !== "object" || Array.isArray(config)) {
		complain(`✗ ${file}: phải là một JSON object`);
		problems++;
		continue;
	}
	checked++;

	const issues = checkConfig(config, schema);
	const unknown = Object.keys(config).filter((name) => !schema.has(name));
	say(`=== ${file}`);
	say(`  ${Object.keys(config).length} key · schema ${schema.size} key · ${unknown.length} key lạ`);
	for (const issue of issues) say(`  ✗ ${issue}`);
	if (issues.length === 0) say("  ✓ hợp lệ: không key lạ, không sai type/enum");
	problems += issues.length;
}

if (targets.length === 2 && fs.existsSync(targets[0]) && fs.existsSync(targets[1])) {
	const same = fs.readFileSync(targets[0], "utf8") === fs.readFileSync(targets[1], "utf8");
	say(`\n${same ? "✓" : "✗"} snapshot repo và file đang chạy giống nhau: ${same ? "CÓ" : "KHÔNG"}`);
	if (!same) problems++;
}

if (problems === 0) {
	say(`\n✓ ${checked} file hợp lệ theo schema trong ${pkgPath}`);
	process.exit(0);
}
say(`\n✗ ${problems} vấn đề — xem danh sách trên`);
process.exit(1);
