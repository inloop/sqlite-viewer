"use strict";

// A tiny, jQuery-like `$` that implements only the handful of helpers this app
// uses, backed by plain DOM APIs. It replaces the bundled jQuery dependency.

// An element is considered hidden when it is display:none or has no layout
// boxes (covers SVG elements, which lack offsetWidth/offsetHeight).
function isHidden(el) {
    return el.style.display === "none" ||
        (!el.style.display && !(el.offsetWidth || el.offsetHeight || el.getClientRects().length));
}

// The display value a freshly created element of the same kind would use, so
// `.show()` can reveal elements hidden by a stylesheet rule (e.g. #output-box).
function defaultDisplay(el) {
    const probe = document.createElement(el.nodeName);
    document.body.appendChild(probe);
    const display = getComputedStyle(probe).display;
    probe.remove();
    return display;
}

function showNode(el) {
    if (el.style.display === "none") el.style.display = "";
    if (isHidden(el)) el.style.display = defaultDisplay(el);
}

function parseHtml(html) {
    const template = document.createElement("template");
    template.innerHTML = html.trim();
    return Array.from(template.content.children);
}

class Dom {
    constructor(nodes) {
        this.nodes = nodes;
    }

    get length() {
        return this.nodes.length;
    }

    each(callback) {
        this.nodes.forEach((node, index) => callback.call(node, index, node));
        return this;
    }

    on(type, handler) {
        return this.each(function () {
            this.addEventListener(type, handler);
        });
    }

    click(handler) {
        if (handler) return this.on("click", handler);
        return this.each(function () {
            this.click();
        });
    }

    keydown(handler) {
        return this.on("keydown", handler);
    }

    addClass(names) {
        const classes = names.split(/\s+/).filter(Boolean);
        return this.each(function () {
            this.classList.add(...classes);
        });
    }

    removeClass(names) {
        const classes = names.split(/\s+/).filter(Boolean);
        return this.each(function () {
            this.classList.remove(...classes);
        });
    }

    toggleClass(names, force) {
        const classes = names.split(/\s+/).filter(Boolean);
        return this.each(function () {
            classes.forEach(name => this.classList.toggle(name, force));
        });
    }

    hasClass(name) {
        return this.nodes.some(node => node.classList.contains(name));
    }

    show() {
        return this.each(function () {
            showNode(this);
        });
    }

    hide() {
        return this.each(function () {
            this.style.display = "none";
        });
    }

    toggle() {
        return this.each(function () {
            if (isHidden(this)) {
                showNode(this);
            } else {
                this.style.display = "none";
            }
        });
    }

    text(value) {
        if (value === undefined) {
            return this.nodes[0] ? this.nodes[0].textContent : "";
        }
        return this.each(function () {
            this.textContent = value;
        });
    }

    attr(name, value) {
        if (value === undefined) {
            return this.nodes[0] ? this.nodes[0].getAttribute(name) : null;
        }
        return this.each(function () {
            this.setAttribute(name, value);
        });
    }

    css(name, value) {
        if (value === undefined) {
            return this.nodes[0] ? getComputedStyle(this.nodes[0]).getPropertyValue(name) : "";
        }
        return this.each(function () {
            this.style.setProperty(name, value);
        });
    }

    find(selector) {
        const found = [];
        this.each(function () {
            found.push(...this.querySelectorAll(selector));
        });
        return new Dom(found);
    }

    append(child) {
        const nodes = child instanceof Dom ? child.nodes : [child];
        return this.each(function () {
            nodes.forEach(node => this.append(node));
        });
    }

    empty() {
        return this.each(function () {
            this.replaceChildren();
        });
    }

    remove() {
        return this.each(function () {
            this.remove();
        });
    }
}

function $(selector, context) {
    if (selector instanceof Dom) return selector;
    if (typeof selector === "string") {
        if (selector.trim().startsWith("<")) return new Dom(parseHtml(selector));
        return new Dom(Array.from((context || document).querySelectorAll(selector)));
    }
    if (selector instanceof Node) return new Dom([selector]);
    if (selector instanceof NodeList || Array.isArray(selector)) return new Dom(Array.from(selector));
    return new Dom([]);
}
