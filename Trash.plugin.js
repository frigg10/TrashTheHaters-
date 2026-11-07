/**
 * @name TrashTheHaters
 * @author Frigg10
 * @description Right-click a user → "Trash" to hide them from your client, including voice/video calls. Untrash from any profile menu. Local only.
 * @version 1.5.0
 * @source https://github.com/
 */

module.exports = class Trash {
    constructor() {
        this.pluginName = "Trash";
        this.vanished = {}; // { [userId]: { username, discriminator?, globalName? } }
        this.styleElement = null;
        this.unpatchContext = null;
        this.observer = null;
        this.scanTimer = null;
        this._hiddenByScan = new WeakSet();
    }

    getName() { return "Trash"; }
    getDescription() {
        return "Right-click a profile → Trash to hide that user (chat + voice/video calls). Right-click any profile to Untrash.";
    }
    getVersion() { return "1.5.0"; }
    getAuthor() { return "Grok"; }

    start() {
        this.loadData();
        this.patchContextMenu();
        this.updateStyles();
        this.startObserver();
        this.startScanLoop();
        BdApi.UI.showToast("Trash started", { type: "success" });
    }

    stop() {
        if (this.unpatchContext) {
            this.unpatchContext();
            this.unpatchContext = null;
        }
        this.stopObserver();
        this.stopScanLoop();
        this.restoreScannedElements();
        this.removeStyles();
        BdApi.UI.showToast("Trash stopped", { type: "info" });
    }

    loadData() {
        // Prefer new key; fall back to old Vanish data so lists carry over
        let data = BdApi.Data.load(this.pluginName, "trashed");
        if (!data || typeof data !== "object") {
            data = BdApi.Data.load("Vanish", "vanished");
        }
        if (!data || typeof data !== "object") {
            data = BdApi.Data.load(this.pluginName, "vanished");
        }
        this.vanished = data && typeof data === "object" ? data : {};
    }

    saveData() {
        BdApi.Data.save(this.pluginName, "trashed", this.vanished);
    }

    isVanished(userId) {
        return Boolean(userId && this.vanished[userId]);
    }

    getDisplayName(entry) {
        if (!entry) return "Unknown";
        if (entry.globalName) return entry.globalName;
        if (entry.username) {
            return entry.discriminator && entry.discriminator !== "0"
                ? `${entry.username}#${entry.discriminator}`
                : entry.username;
        }
        return "Unknown";
    }

    vanishUser(user) {
        if (!user || !user.id) return;
        if (user.id === this.getCurrentUserId()) {
            BdApi.UI.showToast("You cannot trash yourself", { type: "error" });
            return;
        }
        this.vanished[user.id] = {
            username: user.username || "Unknown",
            discriminator: user.discriminator,
            globalName: user.globalName || user.displayName || null
        };
        this.saveData();
        this.updateStyles();
        this.scanAndHideVoice();
        this.tryLocalMute(user.id, true);
        BdApi.UI.showToast(`Dumped ${this.getDisplayName(this.vanished[user.id])} into the trash!`, { type: "success" });
    }

    unvanishUser(userId) {
        if (!userId || !this.vanished[userId]) return;
        const name = this.getDisplayName(this.vanished[userId]);
        delete this.vanished[userId];
        this.saveData();
        this.updateStyles();
        this.restoreScannedElements();
        this.scanAndHideVoice();
        this.tryLocalMute(userId, false);
        BdApi.UI.showToast(`Grabbed ${name} outta the trash`, { type: "success" });
    }

    getCurrentUserId() {
        try {
            const UserStore = BdApi.Webpack.getStore("UserStore");
            return UserStore?.getCurrentUser?.()?.id || null;
        } catch (_) {
            return null;
        }
    }

    // --- Local mute (so you don't hear them in a call) ---
    tryLocalMute(userId, mute) {
        try {
            const MediaEngineStore = BdApi.Webpack.getStore("MediaEngineStore")
                || BdApi.Webpack.getModule(m => m?.getLocalVolume && m?.isLocalMute);
            if (!MediaEngineStore) return;

            // Prefer official local mute API if present
            const setLocalMute = MediaEngineStore.setLocalMute
                || BdApi.Webpack.getModule(m => typeof m?.setLocalMute === "function")?.setLocalMute;
            if (typeof setLocalMute === "function") {
                setLocalMute(userId, mute);
                return;
            }

            // Fallback: set volume to 0 / restore
            const setLocalVolume = MediaEngineStore.setLocalVolume
                || BdApi.Webpack.getModule(m => typeof m?.setLocalVolume === "function")?.setLocalVolume;
            if (typeof setLocalVolume === "function") {
                setLocalVolume(userId, mute ? 0 : 100);
            }
        } catch (e) {
            // Non-fatal; visual hide still works
        }
    }

    muteAllVanished() {
        for (const id of Object.keys(this.vanished)) {
            this.tryLocalMute(id, true);
        }
    }

    extractUser(props) {
        if (!props) return null;
        if (props.user?.id) return props.user;
        if (props.userId) {
            try {
                const UserStore = BdApi.Webpack.getStore("UserStore");
                return UserStore?.getUser?.(props.userId) || { id: props.userId, username: "User" };
            } catch (_) {
                return { id: props.userId, username: "User" };
            }
        }
        if (props.message?.author?.id) return props.message.author;
        if (props.member?.user?.id) return props.member.user;
        if (props.participant?.user?.id) return props.participant.user;
        if (props.participant?.id) return props.participant;
        return null;
    }

    findChildrenArray(node, depth = 0) {
        if (!node || depth > 6) return null;
        const kids = node.props?.children;
        if (Array.isArray(kids)) return kids;
        if (kids && typeof kids === "object") return this.findChildrenArray(kids, depth + 1);
        if (Array.isArray(node)) {
            for (const child of node) {
                const found = this.findChildrenArray(child, depth + 1);
                if (found) return found;
            }
        }
        return null;
    }

    injectMenuItems(tree, props) {
        try {
            const user = this.extractUser(props);
            if (!user?.id) return;

            const children = this.findChildrenArray(tree);
            if (!children || !Array.isArray(children)) return;

            // Prevent double-inject from multiple patches on same menu
            if (children.__vanishInjected) return;
            children.__vanishInjected = true;

            const userId = String(user.id);

            // Separator so it stands out
            try {
                children.push(BdApi.ContextMenu.buildItem({ type: "separator", id: "vanish-sep" }));
            } catch (_) {}

            if (this.isVanished(userId)) {
                children.push(
                    BdApi.ContextMenu.buildItem({
                        id: "trash-untrash-this",
                        label: "Untrash " + this.getDisplayName(this.vanished[userId]),
                        action: () => this.unvanishUser(userId)
                    })
                );
            } else {
                children.push(
                    BdApi.ContextMenu.buildItem({
                        id: "trash-trash",
                        label: "Trash",
                        danger: true,
                        action: () => this.vanishUser(user)
                    })
                );
            }

            // Flat untrash entries for other dumped users
            const vanishedIds = Object.keys(this.vanished).filter((id) => id !== userId);
            for (const id of vanishedIds) {
                children.push(
                    BdApi.ContextMenu.buildItem({
                        id: "trash-untrash-" + id,
                        label: "Untrash " + this.getDisplayName(this.vanished[id]),
                        action: () => this.unvanishUser(id)
                    })
                );
            }
        } catch (e) {
            console.error("[Trash] context menu inject error:", e);
        }
    }

    patchContextMenu() {
        // Single patch only — multiple patches were creating blank duplicate rows
        this.unpatchContext = BdApi.ContextMenu.patch("user-context", (tree, props) => {
            this.injectMenuItems(tree, props);
        });
    }

    buildCss() {
        const ids = Object.keys(this.vanished);
        if (ids.length === 0) return "";

        const rules = [];

        for (const id of ids) {
            // Exact ID matches only — never broad class containers
            // Chat messages
            rules.push(`[data-author-id="${id}"]`);
            rules.push(`li[id*="chat-messages"][id*="-${id}"]`);
            rules.push(`[data-list-item-id*="chat-messages"][data-list-item-id*="${id}"]`);

            // Member / DM / voice list rows keyed by user id in data attributes
            rules.push(`[data-list-item-id*="members"][data-list-item-id*="${id}"]`);
            rules.push(`[data-list-item-id*="private-channels"][data-list-item-id*="${id}"]`);
            rules.push(`[data-list-item-id*="voice"][data-list-item-id*="${id}"]`);
            rules.push(`[data-user-id="${id}"]`);
            rules.push(`[data-userid="${id}"]`);

            // Avatar URL is unique per user: /avatars/<id>/
            // Scope :has() to known single-user row/tile class names only
            rules.push(`[class*="member_"]:has(img[src*="/avatars/${id}/"])`);
            rules.push(`[class*="voiceUser"]:has(img[src*="/avatars/${id}/"])`);
            rules.push(`[class*="voiceUser_"]:has(img[src*="/avatars/${id}/"])`);
            rules.push(`[class*="peopleListItem"]:has(img[src*="/avatars/${id}/"])`);
            rules.push(`[class*="channel_"]:has(img[src*="/avatars/${id}/"])`);

            // Call participant tiles (single-user wrappers only)
            rules.push(`[class*="tile_"]:has(img[src*="/avatars/${id}/"])`);
            rules.push(`[class*="tileSizer"]:has(img[src*="/avatars/${id}/"])`);
            rules.push(`[class*="participant_"]:has(img[src*="/avatars/${id}/"])`);
            rules.push(`[class*="videoWrapper"]:has(img[src*="/avatars/${id}/"])`);
            rules.push(`[class*="voiceUserTile"]:has(img[src*="/avatars/${id}/"])`);
            rules.push(`[class*="streamTile"]:has(img[src*="/avatars/${id}/"])`);
            rules.push(`[class*="stageUser"]:has(img[src*="/avatars/${id}/"])`);
            rules.push(`[class*="stageSpeaker"]:has(img[src*="/avatars/${id}/"])`);
        }

        const unique = [...new Set(rules)];
        return `
/* Trash – hide only the targeted user */
${unique.join(",\n")} {
    display: none !important;
    visibility: hidden !important;
    pointer-events: none !important;
    height: 0 !important;
    max-height: 0 !important;
    overflow: hidden !important;
    margin: 0 !important;
    padding: 0 !important;
    opacity: 0 !important;
    flex: 0 0 0 !important;
}
`;
    }

    updateStyles() {
        this.removeStyles();
        const css = this.buildCss();
        if (!css) return;
        this.styleElement = document.createElement("style");
        this.styleElement.id = "vanish-plugin-styles";
        this.styleElement.textContent = css;
        document.head.appendChild(this.styleElement);
    }

    removeStyles() {
        if (this.styleElement) {
            this.styleElement.remove();
            this.styleElement = null;
        }
        document.getElementById("vanish-plugin-styles")?.remove();
    }

    // DOM scan: hide only the single-user leaf element, never a multi-user parent
    scanAndHideVoice() {
        const ids = Object.keys(this.vanished);
        if (ids.length === 0) return;

        const idSet = new Set(ids);
        const avatarImgs = document.querySelectorAll(
            'img[src*="/avatars/"], img[src*="cdn.discordapp.com/avatars/"]'
        );

        for (const img of avatarImgs) {
            const src = img.src || img.getAttribute("src") || "";
            const match = src.match(/\/avatars\/(\d{17,20})\//);
            if (!match) continue;
            const userId = match[1];
            if (!idSet.has(userId)) continue;

            // Find the nearest single-user container. Stop before multi-user parents.
            let el = img;
            let target = null;
            for (let i = 0; i < 10 && el && el !== document.body; i++) {
                const cls = String(el.className || "");
                const listId = el.getAttribute("data-list-item-id") || "";
                const dataUser = el.getAttribute("data-user-id") || el.getAttribute("data-userid") || "";

                // Hard stop: never hide grids / call containers / channel lists
                if (/gridLayout|callContainer|participants_|voiceStates|content_|scroller|list_|^ul$|^ol$/i.test(cls)
                    || el.tagName === "UL" || el.tagName === "OL"
                    || (el.getAttribute("role") === "grid")
                    || (el.getAttribute("role") === "list" && !listId.includes(userId))) {
                    break;
                }

                // Prefer elements that clearly belong to this one user
                const isSingleUser =
                    dataUser === userId
                    || (listId && listId.includes(userId))
                    || /^(?:.*\b)?(?:voiceUser|member_|tile_|tileSizer|participant_|videoWrapper|voiceUserTile|streamTile|stageUser|peopleListItem|draggable)(?:\b|_)/i.test(cls);

                if (isSingleUser) {
                    // Only accept if this node doesn't contain other users' avatars
                    const otherAvatars = el.querySelectorAll('img[src*="/avatars/"]');
                    let otherUsers = 0;
                    for (const other of otherAvatars) {
                        const m2 = (other.src || "").match(/\/avatars\/(\d{17,20})\//);
                        if (m2 && m2[1] !== userId) otherUsers++;
                    }
                    if (otherUsers === 0) {
                        target = el;
                        // keep climbing a bit for a better (outer) single-user wrapper
                    } else {
                        break; // this parent holds multiple people — don't use it
                    }
                }
                el = el.parentElement;
            }

            if (!target) {
                // Fallback: hide the avatar's closest reasonably small parent only
                target = img.closest('[class*="voiceUser"], [class*="member_"], [class*="tile_"], [class*="participant_"], [class*="videoWrapper"], [data-list-item-id]')
                    || img.parentElement;
            }
            if (!target || target === document.body) continue;
            if (target.dataset.vanishHidden === "true") continue;

            // Final safety: refuse if more than one distinct user avatar is inside
            const avatarsInside = target.querySelectorAll('img[src*="/avatars/"]');
            const userIdsInside = new Set();
            for (const a of avatarsInside) {
                const m3 = (a.src || "").match(/\/avatars\/(\d{17,20})\//);
                if (m3) userIdsInside.add(m3[1]);
            }
            if (userIdsInside.size > 1) continue;

            target.dataset.vanishHidden = "true";
            target.dataset.vanishPrevDisplay = target.style.display || "";
            target.dataset.vanishPrevVisibility = target.style.visibility || "";
            target.style.setProperty("display", "none", "important");
            target.style.setProperty("visibility", "hidden", "important");
            target.style.setProperty("pointer-events", "none", "important");
            this._hiddenByScan.add(target);
        }

        this.muteAllVanished();
    }

    restoreScannedElements() {
        document.querySelectorAll('[data-vanish-hidden="true"]').forEach((el) => {
            el.style.display = el.dataset.vanishPrevDisplay || "";
            el.style.visibility = el.dataset.vanishPrevVisibility || "";
            el.style.pointerEvents = "";
            delete el.dataset.vanishHidden;
            delete el.dataset.vanishPrevDisplay;
            delete el.dataset.vanishPrevVisibility;
        });
    }

    startScanLoop() {
        this.stopScanLoop();
        // Run often enough that new call tiles get hidden quickly
        this.scanTimer = setInterval(() => {
            if (Object.keys(this.vanished).length === 0) return;
            this.scanAndHideVoice();
        }, 800);
        // Immediate pass
        this.scanAndHideVoice();
    }

    stopScanLoop() {
        if (this.scanTimer) {
            clearInterval(this.scanTimer);
            this.scanTimer = null;
        }
    }

    startObserver() {
        this.observer = new MutationObserver(() => {
            if (Object.keys(this.vanished).length === 0) return;
            if (!document.getElementById("vanish-plugin-styles")) {
                this.updateStyles();
            }
        });
        this.observer.observe(document.body, { childList: true, subtree: true });
    }

    stopObserver() {
        if (this.observer) {
            this.observer.disconnect();
            this.observer = null;
        }
    }

    getSettingsPanel() {
        const ids = Object.keys(this.vanished);
        const container = document.createElement("div");
        container.style.padding = "10px";
        container.style.color = "var(--text-normal)";

        const title = document.createElement("h3");
        title.textContent = "Trashed users";
        title.style.marginBottom = "8px";
        container.appendChild(title);

        const note = document.createElement("p");
        note.style.opacity = "0.8";
        note.style.fontSize = "13px";
        note.style.marginBottom = "12px";
        note.textContent =
            "Trashed users are hidden from chat, member list, voice channel list, and call/video tiles. Their audio is also locally muted when possible. They can still hear/see you.";
        container.appendChild(note);

        if (ids.length === 0) {
            const empty = document.createElement("div");
            empty.textContent = "Nobody in the trash.";
            empty.style.opacity = "0.7";
            container.appendChild(empty);
            return container;
        }

        const list = document.createElement("div");
        list.style.display = "flex";
        list.style.flexDirection = "column";
        list.style.gap = "6px";

        for (const id of ids) {
            const row = document.createElement("div");
            row.style.display = "flex";
            row.style.alignItems = "center";
            row.style.justifyContent = "space-between";
            row.style.padding = "6px 8px";
            row.style.background = "var(--background-secondary)";
            row.style.borderRadius = "4px";

            const label = document.createElement("span");
            label.textContent = `${this.getDisplayName(this.vanished[id])} (${id})`;
            label.style.fontSize = "13px";

            const btn = document.createElement("button");
            btn.textContent = "Untrash";
            btn.style.cursor = "pointer";
            btn.style.padding = "4px 10px";
            btn.style.borderRadius = "3px";
            btn.style.border = "none";
            btn.style.background = "var(--button-danger-background, #ed4245)";
            btn.style.color = "#fff";
            btn.onclick = () => {
                this.unvanishUser(id);
                const parent = container.parentElement;
                if (parent) {
                    parent.innerHTML = "";
                    parent.appendChild(this.getSettingsPanel());
                }
            };

            row.appendChild(label);
            row.appendChild(btn);
            list.appendChild(row);
        }
        container.appendChild(list);

        const clearAll = document.createElement("button");
        clearAll.textContent = "Empty the trash";
        clearAll.style.marginTop = "12px";
        clearAll.style.cursor = "pointer";
        clearAll.style.padding = "6px 12px";
        clearAll.style.borderRadius = "3px";
        clearAll.style.border = "none";
        clearAll.style.background = "var(--button-secondary-background)";
        clearAll.style.color = "var(--text-normal)";
        clearAll.onclick = () => {
            for (const id of Object.keys(this.vanished)) {
                this.tryLocalMute(id, false);
            }
            this.vanished = {};
            this.saveData();
            this.updateStyles();
            this.restoreScannedElements();
            BdApi.UI.showToast("Emptied the trash", { type: "success" });
            const parent = container.parentElement;
            if (parent) {
                parent.innerHTML = "";
                parent.appendChild(this.getSettingsPanel());
            }
        };
        container.appendChild(clearAll);

        return container;
    }
};
