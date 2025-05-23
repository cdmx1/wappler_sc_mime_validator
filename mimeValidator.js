const { detectBufferMime, detectFilenameMime } = require('mime-detect');
const { readFile } = require('fs/promises');

exports.mime_validator = async function (options) {
    // 1) parse inputs
    const acceptsStr = this.parseRequired(
        options.accepts,
        'string',
        'A comma separated list of accepted MIME types is required.'
    );
    const inputName = this.parseRequired(
        options.input_name,
        'string',
        'Input name is required.'
    );
    const detectPdfScripts = this.parseOptional(
        options.detectPdfScripts,
        'boolean',
        false
    );
    const detectSvgScripts = this.parseOptional(
        options.detectSvgScripts,
        'boolean',
        true
    );
    const mimeTypesThatAppearAsTextPlain = [
        'text/plain',
        'text/csv',
        'text/tab-separated-values',
        'application/json',
        'application/xml',
        'text/html',
        'text/markdown',
        'text/yaml',
        'application/javascript',
        'application/typescript',
        'text/css',
        'text/x-python',
        'text/x-java-source',
        'text/x-csrc',
        'text/x-c++src',
        'text/x-ruby',
        'application/sql',
    ];


    // 2) fetch file
    const file = this.req.files[inputName];
    if (!file) {
        return {
            is_valid: false,
            message: 'File not found.',
            code: 'ERR101',
            fileData: null,
        };
    }

    // 3) extract only the fields we want for output.fileData
    const { name, size, encoding, mimetype, md5, tempFilePath } = file;
    let output = {
        is_valid: false,
        message: '',
        code: 'ERR101',
        fileData: { name, size, encoding, mimetype, md5 },
    };

    // 4) read buffer asynchronously
    let fileBuffer;
    try {
        fileBuffer = await readFile(tempFilePath);
    } catch (err) {
        output.message = 'Unable to read file.';
        return output;
    }

    // 5) initial extension-based MIME
    const extMime = detectFilenameMime(name);
    const baseExt = extMime.split(';')[0].trim();

    // 6) prepare accept-list and wildcard matcher
    const accepted = acceptsStr.split(',').map(s => s.trim());
    const matchesWildcard = mime =>
        accepted.some(a => {
            if (a === '*/*' || a === mime) return true;
            const [t, st] = a.split('/');
            const [mt, mst] = mime.split('/');
            if (t === '*' || t === mt) {
                return st === '*' || mst === st;
            }
            return false;
        });

    // 7) early reject based on extension check
    if (!matchesWildcard(baseExt)) {
        output.message = 'File type not allowed (extension).';
        return output;
    }

    const isTextPlain = mime =>
        mimeTypesThatAppearAsTextPlain.some(m => m === mime);

    if (isTextPlain(baseExt)) {
        accepted.push('text/plain');
    }
    // 8) sniff buffer MIME (may include “; charset=…”)
    const bufferMimeRaw = await detectBufferMime(fileBuffer);
    const baseBuf = bufferMimeRaw.split(';')[0].trim();

    if (!matchesWildcard(baseBuf)) {
        output.message = 'File type not allowed (content).';
        return output;
    }

    // // 9) normalize the final MIME string only if bufferMimeRaw lacks parameters
    // const finalMime = bufferMimeRaw.includes(';')
    //     ? bufferMimeRaw
    //     : detectFilenameMime(name, bufferMimeRaw);

    // unchanged helpers

    function hasMaliciousPDFContent(buffer) {
        const text = buffer.toString('latin1');
        const patterns = [/\/JavaScript\b/, /\/JS\b/, /\/AA\b/];
        return patterns.some(p => p.test(text));
    }

    function hasMaliciousSVGContent(buffer) {
        const text = buffer.toString('utf8');
        const patterns = [
            /<script\b/i,
            /on\w+="[^"]*"/i,
            /on\w+='[^']*'/i,
            /javascript:/i,
            /data:text\/html/i,
            /<[^>]+xlink:href=['"]?javascript:/i,
        ];
        return patterns.some(p => p.test(text));
    }
    // 10) deep script scans
    const isCSVBuffer = (buffer) => {

        const sample = buffer.toString('utf-8', 0, 2048); // read a small portion
        const lines = sample.split(/\r?\n/).filter(Boolean);

        // Heuristic: at least 2 rows, at least 2 comma-separated columns
        if (lines.length >= 2) {
            const [firstLine, secondLine] = lines;
            if (firstLine.includes(',') && secondLine.includes(',')) {
                const cols1 = firstLine.split(',').length;
                const cols2 = secondLine.split(',').length;
                if (cols1 > 1 && cols1 === cols2) return true;
            }
        }

        return false;
    };

    if (baseExt === 'text/csv' && !isCSVBuffer(fileBuffer)) {
        return {
            ...output,
            code: 'ERR101',
            message: 'File type not allowed (content).',
        };

    }

    if (
        detectPdfScripts &&
        baseBuf === 'application/pdf' &&
        hasMaliciousPDFContent(fileBuffer)
    ) {
        return {
            ...output,
            code: 'ERR102',
            message: 'Embedded JavaScript detected in PDF.',
        };
    }

    if (
        detectSvgScripts &&
        baseBuf === 'image/svg+xml' &&
        hasMaliciousSVGContent(fileBuffer)
    ) {
        return {
            ...output,
            code: 'ERR103',
            message: 'Potential XSS risk: Dangerous SVG content.',
        };
    }

    // 11) all checks passed
    return {
        ...output,
        is_valid: true,
        code: 0,
        // if you want to return the MIME you actually used, include finalMime here:
        // detectedMime: finalMime
    };
};