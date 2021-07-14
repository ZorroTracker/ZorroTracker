import { WindowType } from "../../defs/windowtype";
/**
 * So.. In order for Jest testing to work, we need to load stuff as modules. However, browsers really don't like CommonJS modules
 * Also, Electron does not work with ES2015 modules. Also, trying to use mix of both is apparently borked to hell. Here we have an
 * amazing solution: Just pretend "exports" exists. Yeah. This will be filled with garbage, probably. But this fixes the issue
 * where browsers don't support CommonJS modules. As it turns out, this single line will fix the issues we're having. I hate this.
 */
window.exports = {};

// set window type
window.type = WindowType.Editor;

// helper function to reload the current theme
window.reloadTheme = () => {
	reloadTheme();
};

// @ts-expect-error - the remaining functions will be defined by all.ts
window.preload = {
	/* open a VGM file */
	vgm: async function() {
		const result = await window.ipc.ui.dialog.open("openfolder", {
			properties: [ "openFile", ],
			filters: [
				{ name: "Vgm Files", extensions: [ "vgm", ], },
				{ name: "All Files", extensions: [ "*", ], },
			],
		});

		// if invalid file was applied or operation was cancelled, abort
		if(!result) {
			return;
		}

		// stop the audio playback and restart it with the new file opened. TODO: This is only test code!
		console.log("VGM", result);
		window.ipc.audio?.stop();
		setTimeout(() => window.ipc.audio?.play(result), 50);
	},

	/**
	 * Execute a shortcut action. This is usually done within UI, such as toolbar
	 *
	 * @param name The name of the shortcut to execute
	 */
	shortcut: async(name:string[]) => {
		await doShortcut(name);
	},
}

import { addShortcutReceiver, doShortcut } from "../misc/shortcuts";
import { loadDefaultToolbar } from "../elements/toolbar/toolbar";
import { loadFlag, SettingsTypes } from "../../api/files";
import { Project } from "../misc/project";
import { clearChildren, fadeToLayout, loadTransition, removeTransition } from "../misc/layout";
import { ZorroEvent, ZorroEventEnum, ZorroEventObject } from "../../api/events";
import { volumeSlider, SliderEnum } from "../elements/slider/slider";
import { closePopups, confirmationDialog, createFilename, PopupColors, PopupSizes } from "../elements/popup/popup";
import { Undo } from "../../api/undo";
import { MatrixEditor } from "../elements/matrixeditor/main";
import { Piano } from "../elements/piano/piano";
import { PatternEditor } from "../elements/patterneditor/main";
import { MIDI } from "../misc/MIDI";

/* ipc communication */
import "../../system/ipc/html editor";
import { loadTheme, reloadTheme } from "../misc/theme";
import { createBar } from "../elements/playbuttonsbar/main";

async function loadMainShortcuts() {
	// load all.ts asynchronously. This will setup our environment better than we can do here
	const module = await import("./all");

	module.loadStandardShortcuts(SettingsTypes.editorShortcuts, {
		/* shortcut for opening a file or a project */
		open: async() => {
			// first, ask to save the current project. If user presses cancel, then do not run the code
			if(!await askSavePopup()) {
				return false;
			}

			// open the openFileDialog to find the target file
			const result = await window.ipc.ui.dialog.open("openfolder", {
				properties: [ "openFile", ],
				filters: [
					{ name: "ZorroTracker Module Files", extensions: [ "ztm", ], },
					{ name: "ZorroTracker Files", extensions: [ "zip", ], },
					{ name: "All Files", extensions: [ "*", ], },
				],
			});

			// if invalid file was applied or operation was cancelled, abort
			if(!result) {
				return false;
			}

			// open loading animation
			loadTransition();
			Undo.clear();

			// try to load the project
			const p = await Project.loadProject(result);

			if(!p){
				removeTransition();
				return false;
			}

			// save project as current
			await Project.setActiveProject(p);

			// let all windows know about the loaded project
			window.ipc.project?.init(p);

			// reload layout
			await fadeToLayout(editorLayout);
			removeTransition();
			return true;
		},

		/* shortcut for creating a new project */
		new: async() => {
			// first, ask to save the current project. If user presses cancel, then do not run the code
			if(!await askSavePopup()) {
				return false;
			}

			// open loading animation
			loadTransition();
			Undo.clear();

			// try to load the project
			const p = await Project.createProject();

			if(!p){
				removeTransition();
				return false;
			}

			// save project as current
			await Project.setActiveProject(p);

			// let all windows know about the loaded project
			window.ipc.project?.init(p);

			// reload layout
			await fadeToLayout(editorLayout);
			removeTransition();
			return true;
		},

		/* shortcut for closing a project */
		close: () => {
			return false;
		},

		/* shortcut for doing a redo action */
		redo: () => {
			return Undo.redo();
		},

		/* shortcut for doing a undo action */
		undo: () => {
			return Undo.undo();
		},

		/* shortcut for doing a save action */
		save: async() => {
			try {
				return await Project.current?.save(false) ?? false;

			} catch(ex)  {
				console.error(ex);
			}

			return false;
		},

		/* shortcut for doing a save as action */
		saveas: async() => {
			try {
				return await Project.current?.saveAs() ?? false;

			} catch(ex)  {
				console.error(ex);
			}

			return false;
		},
	});
}

// request the appPath variable from main thread
window.ipc.ui.path().then(async() => {
	// TODO: Temporary code to initiate the system theme
	const themes = await window.ipc.theme.findAll();
	const tcur = themes[loadFlag<string>("THEME") ?? "prototype"];

	if(tcur) {
		loadTheme(tcur);
	}

	// TODO: Temporary code to initiate the audio system with an emulator and set volume. Bad!
	window.ipc.audio?.setChip(loadFlag<string>("CHIP") ?? "");

	// create the loading animation
	loadTransition();
	await loadMainShortcuts();

	/* load the menu */
	loadDefaultToolbar(true);

	// enable discord RPC
	if(loadFlag<boolean>("DISCORD_RPC")) {
		// load Discord RPC integration
		window.ipc.rpc?.init();
		import("../misc/rpc").catch(console.error);
	}

	// TEMP volume hack
	setTimeout(() => {
		volumeSlider(SliderEnum.Small).catch(console.error);
	}, 100);

	// check if we should attempt loading the previous project
	if(loadFlag<boolean>("OPEN_PREVIOUS")) {
		// get the cookie for the project
		const url = await window.ipc.cookie.get("lastproject");

		try {
			if((url?.length ?? 0) > 0) {
				// attempt to load project
				Project.current = await Project.loadProject(url as string);
			}

		} catch(ex) { /* ignore */ }
	}

	// if no valid project is loaded still, create a blank project
	if(!Project.current) {
		Project.current = await Project.createProject();
	}

	// let the other windows know about this project
	window.ipc.project?.init(Project.current);

	// load the editor
	await fadeToLayout(editorLayout);

	// initialize the MIDI input polling
	MIDI.init();

	// init shortcut handler and remove the loading animation
	initShortcutHandler();
	removeTransition();

}).catch(console.error);

// handler for receiving shortcuts
let matrixEditor: MatrixEditor|undefined;
let patternEditor: PatternEditor|undefined;
let piano: Piano|undefined;

// note, this is here just because in testing it might not actually exist!
function initShortcutHandler() {
	// eslint-disable-next-line require-await
	addShortcutReceiver("layout", async(data, e, state) => {
		switch(data.shift()) {
			case "matrix":
				return matrixEditor?.receiveShortcut(data, e, state) ?? false;

			case "pattern":
				return patternEditor?.receiveShortcut(data, e, state) ?? false;

			case "piano":
				return piano?.receiveShortcut(data, e, state) ?? false;
		}

		return false;
	});
}

/**
 * Function to change the module and reload the editor
 *
 * @param index The module index to load to
 */
export async function loadToModule(index:number, func?:() => Promise<void>): Promise<void> {
	// open loading animation
	loadTransition();
	Undo.clear();

	if(!await fadeToLayout(async() => {
		// set the active layout
		await Project.current?.setActiveModuleIndex(index);

		// if extra function added, then run it
		if(func) {
			await func();
		}

		// if the index is negative then bail
		if(index < 0) {
			return false;
		}

		// reload layout
		await editorLayout();

		return true;
	})) {
		return;
	}

	// only do if index >= 0
	removeTransition();
}

// load the layout for this window
async function editorLayout():Promise<true> {
	// load the editor parent element as `body`
	const body = document.getElementById("main_content");

	// check if it was found and is a div
	if(!body || !(body instanceof HTMLDivElement)){
		throw new Error("Unable to load editor layout: parent element main_content not found!");
	}

	if(!Project.current) {
		throw new Error("Failed to load editorLayout: No project loaded.");
	}

	clearChildren(body);
	/**
	 * -------------------------------------
	 * matrix edit     | settings
	 * -------------------------------------
	 * pattern edit
	 *           piano (float)
	 * -------------------------------------
	 */

	const _top = document.createElement("div");
	_top.id = "editor_top";
	body.appendChild(_top);

	_top.appendChild((matrixEditor = new MatrixEditor(Project.current.index)).element);

	const _bot = document.createElement("div");
	_bot.id = "editor_bottom";
	body.appendChild(_bot);

	_top.appendChild(createBar());
	_top.appendChild(await volumeSlider(SliderEnum.Horizontal | SliderEnum.Medium));

	_top.appendChild(document.createElement("br"));

	{
		const e = document.createElement("div");
		e.id = "midi";
		_top.appendChild(e);
	}

	// load channel mute buttons
	Project.current.index.channels.forEach((c) => {
		const b = document.createElement("label");
		b.innerHTML = /*html*/`
			<div style="white-space: nowrap; display: inline-block;">
				<input type="checkbox" onchange="window.ipc.driver.mute({ id: ${ c.id }}, this.checked)" />
				${ c.name }
			</div>
		`;

		_top.appendChild(b);
	});

	// add the piano overlay
	_bot.appendChild((piano = await Piano.create()).element);

	// add the pattern editor here
	_bot.appendChild((patternEditor = new PatternEditor(Project.current.index)).element);
	return true;
}

/**
 * Event listener and handler for program exit, making ABSOLUTELY SURE that the user saves their progress!!!
 */
// eslint-disable-next-line require-await
ZorroEvent.addListener(ZorroEventEnum.Exit, async(event:ZorroEventObject) => {
	// ask if the user wants to save, and if user cancels, then cancel the exit event too.
	if(!await askSavePopup()) {
		event.cancel();
	}
});

/**
 * Function for asking the user whether to save, not save or cancel, when project is dirty.
 *
 * @returns Boolean indicating whether or not user pressed the `cancel` button. `false` if the user did.
 */
export async function askSavePopup():Promise<boolean> {
	if(Project.current && Project.current.isDirty()) {
		try {
			// ask the user what to do
			switch(await confirmationDialog({
				color: PopupColors.Normal,
				size: PopupSizes.Small,
				html: /*html*/`
					<h2>Do you want to save your changes to ${ createFilename(Project.current.getFilename(), "?") }</h2>
					<p>Your changes <u>will</u> be lost if you don't save them.</p>
				`, buttons: [
					{ result: 0, float: "left", color: PopupColors.Caution, html: "Don't save", },
					{ result: 2, float: "right", color: PopupColors.Info, html: "Save", },
					{ result: 1, float: "right", color: PopupColors.Normal, html: "Cancel", },
				],
			}) as number) {
				case 2:						// ask the user to save.
					// If there is a save-as dialog and user cancels, or save fails, pretend the cancel button was pressed.
					return Project.current.save(false);

				case 0: return true;		// literally do nothing
				default: return false;		// indicate as cancelling
			}

		// on error cancel
		} catch(err) {
			return false;
		}

	} else {
		// see if we can close the active popups
		return closePopups();
	}
}
