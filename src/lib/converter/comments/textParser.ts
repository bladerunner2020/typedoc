/**
 * Parser to handle plain text markdown.
 *
 * Responsible for recognizing relative paths within the text and turning
 * them into references.
 * @module
 */
import { TranslationProxy, TranslatedString } from "../../internationalization";
import { Comment, CommentDisplayPart } from "../../models";
import { MediaRegistry } from "../../models/MediaRegistry";
import { Token } from "./lexer";

import MarkdownIt from "markdown-it";
const MdHelpers = new MarkdownIt().helpers;

interface TextParserData {
    comment: Comment;
    token: Token;
    pos: number;
    i18n: TranslationProxy;
    warning: (msg: TranslatedString, token: Token) => void;
    media: MediaRegistry;
    atNewLine: boolean;
}

interface RelativeLink {
    pos: number;
    end: number;
    target: number;
}

/**
 * Look for relative links within a piece of text and add them to the {@link MediaRegistry}
 * so that they can be correctly resolved during rendering.
 *
 * TODO: We also handle `<a>` and `<img>` tags with relative targets here.
 *
 */
export function textContent(
    comment: Comment,
    token: Token,
    i18n: TranslationProxy,
    warning: (msg: TranslatedString, token: Token) => void,
    outContent: CommentDisplayPart[],
    media: MediaRegistry,
    atNewLine: boolean,
) {
    let lastPartEnd = 0;
    const data: TextParserData = {
        comment,
        token,
        pos: 0,
        i18n,
        warning,
        media,
        atNewLine,
    };

    function addRef(ref: RelativeLink) {
        outContent.push({
            kind: "text",
            text: token.text.slice(lastPartEnd, ref.pos),
        });
        outContent.push({
            kind: "relative-link",
            text: token.text.slice(ref.pos, ref.end),
            target: ref.target,
        });
        lastPartEnd = ref.end;
        data.pos = lastPartEnd;
    }

    while (data.pos < token.text.length) {
        const link = checkMarkdownLink(data);
        if (link) {
            addRef(link);
            continue;
        }

        const reference = checkReference(data);
        if (reference) {
            addRef(reference);
            continue;
        }

        ++data.pos;
    }

    if (lastPartEnd !== token.text.length) {
        outContent.push({ kind: "text", text: token.text.slice(lastPartEnd) });
    }
}

/**
 * Links are inline text with the form `[ text ]( url title )`.
 *
 * Images are just links with a leading `!` and lack of support for `[ref]` referring to a path
 * defined elsewhere, we don't care about that distinction here as we'll only replace the path
 * piece of the image.
 *
 * Reference: https://github.com/markdown-it/markdown-it/blob/14.1.0/lib/rules_inline/link.mjs
 * Reference: https://github.com/markdown-it/markdown-it/blob/14.1.0/lib/rules_inline/image.mjs
 *
 */
function checkMarkdownLink(data: TextParserData): RelativeLink | undefined {
    const { token, comment, media } = data;

    if (token.text[data.pos] === "[") {
        const labelEnd = findLabelEnd(token.text, data.pos + 1);
        if (
            labelEnd !== -1 &&
            token.text[labelEnd] === "]" &&
            token.text[labelEnd + 1] === "("
        ) {
            const link = MdHelpers.parseLinkDestination(
                token.text,
                labelEnd + 2,
                token.text.length,
            );

            if (link.ok) {
                // Only make a relative-link display part if it's actually a relative link.
                // Discard protocol:// links, unix style absolute paths, and windows style absolute paths.
                if (isRelativeLink(link.str)) {
                    return {
                        pos: labelEnd + 2,
                        end: link.pos,
                        target: media.register(comment.sourcePath!, link.str),
                    };
                }

                // This was a link, skip ahead to ensure we don't happen to parse
                // something else as a link within the link.
                data.pos = link.pos - 1;
            }
        }
    }
}

/**
 * Reference definitions are blocks with the form `[label]: link title`
 * Reference: https://github.com/markdown-it/markdown-it/blob/14.1.0/lib/rules_block/reference.mjs
 *
 * Note: This may include false positives where TypeDoc recognizes a reference block that markdown
 * does not if users start lines with something that looks like a reference block without fully
 * separating it from an above paragraph. For a first cut, this is good enough.
 */
function checkReference(data: TextParserData): RelativeLink | undefined {
    const { atNewLine, pos, token, media, comment } = data;

    if (atNewLine) {
        let lookahead = pos;
        while (/[ \t]/.test(token.text[lookahead])) {
            ++lookahead;
        }
        if (token.text[lookahead] === "[") {
            while (
                lookahead < token.text.length &&
                /[^\n\]]/.test(token.text[lookahead])
            ) {
                ++lookahead;
            }
            if (token.text.startsWith("]:", lookahead)) {
                lookahead += 2;
                while (/[ \t]/.test(token.text[lookahead])) {
                    ++lookahead;
                }

                const link = MdHelpers.parseLinkDestination(
                    token.text,
                    lookahead,
                    token.text.length,
                );

                if (link.ok) {
                    if (isRelativeLink(link.str)) {
                        return {
                            pos: lookahead,
                            end: link.pos,
                            target: media.register(
                                comment.sourcePath!,
                                link.str,
                            ),
                        };
                    }

                    data.pos = link.pos - 1;
                }
            }
        }
    }
}

function isRelativeLink(link: string) {
    return !/^[a-z]+:\/\/|^\/|^[a-z]:\\/i.test(link);
}

function findLabelEnd(text: string, pos: number) {
    while (pos < text.length) {
        switch (text[pos]) {
            case "\n":
            case "]":
                return pos;
        }
        ++pos;
    }

    return -1;
}