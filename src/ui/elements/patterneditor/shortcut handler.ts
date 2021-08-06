import { FeatureFlag } from "../../../api/driver";
import { ZorroEvent, ZorroEventEnum, ZorroEventObject } from "../../../api/events";
import { PatternCell, PatternData } from "../../../api/matrix";
import { Note } from "../../../api/notes";
import { Position, shortcutDirection, UIShortcutHandler } from "../../../api/ui";
import { PatternEditor } from "./main";
import { MultiSelection, SingleSelection } from "./selection manager";

// create events
const eventNoteOn = ZorroEvent.createEvent(ZorroEventEnum.PianoNoteOn);
const eventNoteOff = ZorroEvent.createEvent(ZorroEventEnum.PianoNoteOff);

export class PatternEditorShortcuts implements UIShortcutHandler {
	private parent:PatternEditor;

	constructor(parent:PatternEditor) {
		this.parent = parent;
		_shortcut = this;
	}

	/**
	 * Helper function to handle movement checks
	 */
	private handleMovementCheck(direction:string|undefined, cb: (position:Position) => boolean|Promise<boolean>) {
		// load the position offset for the direction
		const position = shortcutDirection(direction);

		if(position) {
			// if valid, call the function to handle it
			return cb(position);
		}

		return false;
	}

	/**
	 * Helper function to get the selection target. Either single selection or second element of multi selection.
	 */
	private getSelectionTarget(): [ SingleSelection, (x:number, y:number, wrap:boolean) => boolean|Promise<boolean>, boolean ] {
		const mode = !this.parent.selectionManager.multi;

		// return the values according to whether multi selection exists
		return [
			mode ? this.parent.selectionManager.single : (this.parent.selectionManager.multi as MultiSelection)[1],
			mode ? (x:number, y:number, wrap:boolean) => this.parent.selectionManager.moveSingle(x, y, wrap) :
				(x:number, y:number, wrap:boolean) => this.parent.selectionManager.moveMulti(x, y, wrap),
			mode,
		];
	}

	/**
	 * Helper function to check if multi selection exists, and if not, then clone the single selection as both of the points in multi selection
	 */
	private checkMultiSelection() {
		if(!this.parent.selectionManager.multi) {
			this.parent.selectionManager.multi = [
				{ ...this.parent.selectionManager.single, },
				{ ...this.parent.selectionManager.single, },
			]
		}
	}

	/**
	 * Helper function to check if multi-selection is in the full column(s)
	 *
	 * @param channel If set, then check also that th full channel is selected
	 */
	private checkSelectAll(channel:boolean) {
		// load the multi seleciton and check if its valid
		const sl = this.parent.selectionManager.multi;

		if(sl) {
			// determine the top and bottom positions of the selection
			const top = +(sl[0].row > sl[1].row);

			// if selection is already at the top and bottom, then check if its around the cursor
			if(sl[top].row === 0 && sl[1-top].row === this.parent.patternLen - 1) {
				// check the if the selection is selecting the entire channel
				const left = +(sl[0].element > sl[1].element);

				if(!channel || (sl[left].element === 0 && sl[1-left].element === this.parent.channelInfo[sl[1-left].channel].elements.length - 1)) {
					// helper function to find the offset from the single selection and multi selection.
					const check = (sel:SingleSelection) => {
						return sel.channel !== this.parent.selectionManager.single.channel ?
							sel.channel - this.parent.selectionManager.single.channel :
							sel.element - this.parent.selectionManager.single.element;
					}

					// check if single selection is inside the multi selection
					const soff = sl.map((s) => check(s));
					if((soff[0] === 0 || soff[1] === 0 || (soff[0] <= 0) !== (soff[1] <= 0))) {
						// if so, then ignore shortcut
						return false;
					}
				}
			}
		}

		return true;
	}

	/**
	 * Function to receive shortcut events from the user.
	 *
	 * @param shortcut Array of strings representing the shotcut data
	 * @returns Whether the shortcut was executed
	 */
	// eslint-disable-next-line require-await
	public async receiveShortcut(data:string[], e:KeyboardEvent|undefined, state:boolean|undefined):Promise<boolean> {
		// has focus, process the shortcut
		switch(data.shift()) {
			case "sel": return this.handleSelectionShortcut(data);
			case "chfx": return this.handleChannelEffectsShortcut(data);
			case "note": return this.handleNoteShortcut(data, state);
		}

		return false;
	}

	/**
	 * Handle shortcuts from the `sel` subgroup
	 */
	private handleChannelEffectsShortcut(data:string[]) {
		return this.handleMovementCheck(data.shift(), async(pos:Position) => {
			if(pos.y) {
				// got up/down, load channel
				const ch = this.parent.selectionManager.single.channel;

				// check if this channel supports effects
				if((this.parent.tab.channels[ch].features & FeatureFlag.EFFECTS) === 0) {
					return false;
				}

				// calculate the effects number
				const fx = Math.max(1, Math.min(this.parent.maxEffects, this.parent.tab.channels[ch].info.effects - pos.y));

				if(this.parent.tab.channels[ch].info.effects !== fx) {
					// effects amount changed, update now
					await this.parent.setChannelEffects(fx, ch);
					return true;
				}
			}

			return false;
		});
	}

	/**
	 * Handle shortcuts from the `sel` subgroup
	 */
	private async handleSelectionShortcut(data:string[]) {
		switch(data.shift()) {
			case "move":
				return this.handleMovementCheck(data.shift(), (pos:Position) => {
					// load the selection target
					const [ , fn, wrap, ] = this.getSelectionTarget();

					// move selection by position
					return fn(pos.x, pos.y, wrap);
				});

			case "extend":
				return this.handleMovementCheck(data.shift(), (pos:Position) => {
					// if there is no multi selection, clone single selection as the multi selection
					this.checkMultiSelection();

					// extend multi selection
					return this.parent.selectionManager.extendMulti(pos.x, pos.y, false);
				});

			case "scroll":
				return this.handleMovementCheck(data.shift(), (pos:Position) => {
					// load the selection target
					const [ , fn, wrap, ] = this.getSelectionTarget();

					// move selection by position
					return fn(pos.x * 4, pos.y * 4, wrap);
				});

			case "scrollextend":
				return this.handleMovementCheck(data.shift(), (pos:Position) => {
					// if there is no multi selection, clone single selection as the multi selection
					this.checkMultiSelection();

					// extend multi selection
					return this.parent.selectionManager.extendMulti(pos.x * 4, pos.y * 4, false);
				});

			case "movechannel":
				return this.handleMovementCheck(data.shift(), async(pos:Position) => {
					if(pos.x) {
						// function to move the selection
						const move = (sel:SingleSelection, wrap:boolean) => {
							// check if channel is already maximum/minimum
							if(!wrap && (pos.x < 0 ? (sel.channel <= 0) : (sel.channel >= this.parent.channelInfo.length - 1))) {
								return false;
							}

							// move the target channel
							sel.channel += pos.x + this.parent.channelInfo.length;
							sel.channel %= this.parent.channelInfo.length;
							return true;
						};

						// load the selection target
						const [ target, fn, wrap, ] = this.getSelectionTarget();

						if(target === this.parent.selectionManager.single) {
							// single mode, move the channel only
							target.element = 0;
							move(target, true);

						} else if(this.parent.selectionManager.multi) {
							// multi mode, do some special handling
							const sl = this.parent.selectionManager.multi;
							const md = sl[0].channel === sl[1].channel ? "element" : "channel";
							const l = +(sl[0][md] < sl[1][md]);

							// check if the channel is the same
							if(sl[0].channel === sl[1].channel && (sl[1-l].element !== 0 ||
								sl[l].element !== this.parent.channelInfo[sl[l].channel].elements.length - 1)) {
									// special case where the whole channel is highlighted
									sl[l].element = this.parent.channelInfo[sl[l].channel].elements.length - 1;
									sl[1-l].element = 0;

							} else if(pos.x > 0) {
								if(move(sl[1-l], false)) {
									// align the selection to the channel
									sl[1-l].element = this.parent.channelInfo[sl[1-l].channel].elements.length - 1;
									sl[l].element = 0;
									sl[l].channel = sl[1-l].channel;
								}

							} else if(move(sl[l], false)){
								sl[l].element = this.parent.channelInfo[sl[l].channel].elements.length - 1;
								sl[1-l].element = 0;
								sl[1-l].channel = sl[l].channel;
							}

							// update single selection
							const target = +(pos.x > 0 !== sl[0][md] > sl[1][md]);
							this.parent.selectionManager.single.channel = sl[target].channel;
							this.parent.selectionManager.single.element = sl[target].element;

							// update channel and visibility
							await this.parent.scrollManager.ensureVisibleChannel(sl[target].channel, sl[target].channel);
							await this.parent.tab.setSelectedChannel(sl[target].channel);
							this.parent.selectionManager.render();
						}

						// move left/right by a single channel
						return fn(0, 0, wrap);
					}

					return false;
				});

			case "rowtop": {
				// load the selection target
				const [ target, fn, wrap, ] = this.getSelectionTarget();

				// move to the top row of the pattern
				target.row = 0;
				return fn(0, -0.0001, wrap);
			}

			case "rowbottom": {
				// load the selection target
				const [ target, fn, wrap, ] = this.getSelectionTarget();

				// move to the bottom row of the pattern
				target.row = this.parent.patternLen - 1;
				return fn(0, 0.0001, wrap);
			}

			case "extendtop": {
				// if there is no multi selection, clone single selection as the multi selection
				this.checkMultiSelection();

				// find which selection is closest to the top
				const sl = this.parent.selectionManager.multi as MultiSelection;
				const t = +(sl[0].row > sl[1].row);

				// set the row and scroll
				this.parent.selectionManager.single.row = sl[t].row = 0;
				await this.parent.scrollManager.scrollToRow(this.parent.selectionManager.single.pattern * this.parent.patternLen);
				return true;
			}

			case "extendbottom": {
				// if there is no multi selection, clone single selection as the multi selection
				this.checkMultiSelection();

				// find which selection is closest to the bottom
				const sl = this.parent.selectionManager.multi as MultiSelection;
				const t = +(sl[0].row < sl[1].row);

				// set the row and scroll
				this.parent.selectionManager.single.row = sl[t].row = this.parent.patternLen - 1;
				await this.parent.scrollManager.scrollToRow(((this.parent.selectionManager.single.pattern + 1) * this.parent.patternLen) - 1);
				return true;
			}

			case "movepattern":
				return this.handleMovementCheck(data.shift(), (pos:Position) => {
					if(pos.y) {
						// remove multi selection
						this.parent.selectionManager.clearMultiSelection();

						// move up/down by a single pattern
						return this.parent.selectionManager.moveSingle(0, pos.y * this.parent.patternLen, true);
					}

					return false;
				});

			case "movehighlight":
				return this.handleMovementCheck(data.shift(), (pos:Position) => {
					if(pos.y) {
						// remove multi selection
						this.parent.selectionManager.clearMultiSelection();

						// prepare variables
						const row = this.parent.selectionManager.single.row;
						const yoff:number[] = [];

						// helper function to correctly calculate the highlight
						const loadOff = (hilite:number) => {
							if(hilite < this.parent.patternLen) {
								// load the target position
								let target = ((pos.y < 0 ? 0 : hilite) - (row % hilite)) || -hilite;

								// check if position crosses the pattern
								if(target >= this.parent.patternLen - row) {
									target = this.parent.patternLen - row;

								} else if(target < -row){
									target = ((pos.y < 0 ? 0 : hilite) - (this.parent.patternLen % hilite)) || -hilite;
								}

								// put the target position in the array
								yoff.push(target);
							}
						};

						// load the row positions
						this.parent.scrollManager.rowHighlights.forEach((h) => loadOff(h));

						// if no targets defined, defined one
						if(yoff.length === 0){
							yoff.push((pos.y < 0 ? 0 : this.parent.patternLen) - row);
						}

						// move up/down to the closest highlight
						return this.parent.selectionManager.moveSingle(0, Math[pos.y < 0 ? "max" : "min"](...yoff), true);
					}

					return false;
				});

			case "patterntop": {
				// remove multi selection
				this.parent.selectionManager.clearMultiSelection();

				// move to the top row of the pattern
				this.parent.selectionManager.single.row = 0;
				this.parent.selectionManager.single.pattern = 0;
				return this.parent.selectionManager.moveSingle(0, -0.0001, true);
			}

			case "patternbottom": {
				// remove multi selection
				this.parent.selectionManager.clearMultiSelection();

				// move to the bottom row of the pattern
				this.parent.selectionManager.single.row = this.parent.patternLen - 1;
				this.parent.selectionManager.single.pattern = this.parent.tab.matrix.matrixlen - 1;
				return this.parent.selectionManager.moveSingle(0, 0.0001, true);
			}

			case "fullcolumn": {
				if(!this.checkSelectAll(false)) {
					return false;
				}

				// set the multi selection on the single selection column
				const sl = this.parent.selectionManager.multi = [
					{ ...this.parent.selectionManager.single, },
					{ ...this.parent.selectionManager.single, },
				];

				sl[0].row = 0;
				sl[1].row = this.parent.patternLen - 1;

				// re-render the selection
				this.parent.selectionManager.render();
				return true;
			}

			case "fullchannel": {
				if(!this.checkSelectAll(true)) {
					return false;
				}

				// set the multi selection on the single selection column
				const sl = this.parent.selectionManager.multi = [
					{ ...this.parent.selectionManager.single, },
					{ ...this.parent.selectionManager.single, },
				];

				sl[0].row = 0;
				sl[0].element = 0;
				sl[1].row = this.parent.patternLen - 1;
				sl[1].element = this.parent.channelInfo[this.parent.selectionManager.single.channel].elements.length - 1;

				// re-render the selection
				this.parent.selectionManager.render();
				return true;
			}

			case "fullpattern": {
				// initialize the selection at the edges of the pattern
				this.parent.selectionManager.multi = [
					{
						pattern: this.parent.selectionManager.single.pattern,
						row: 0, channel: 0, element: 0,
					},
					{
						pattern: this.parent.selectionManager.single.pattern,
						row: this.parent.patternLen - 1,
						channel: this.parent.channelInfo.length - 1,
						element: this.parent.channelInfo[this.parent.channelInfo.length - 1].elements.length - 1,
					},
				];

				// re-render the selection
				this.parent.selectionManager.render();
				return true;
			}

			case "deselect":
				// remove multi selection
				return this.parent.selectionManager.clearMultiSelection();
		}

		return false;
	}

	/**
	 * Map strings to note numbers. This will allow the Piano to correctly release notes
	 */
	private scmap:{ [key:string]: number, } = {};

	/**
	 * Handle shortcuts from the `note` subgroup
	 */
	private handleNoteShortcut(data:string[], state:boolean|undefined) {
		// helper function to process an octave of notes
		const octave = (data:string[], octave:number) => {
			// helper function to trigger a single note
			const note = async(note:number) => {
				// get the scmap name for this note
				const name = octave +"-"+ note;

				if(state) {
					// fetch octave info
					const octaveInfo = (await this.parent.tab.getNotes(this.parent.tab.selectedChannel.type)).octave;

					// calculate the note
					const n = octaveInfo.C0 + note + ((this.parent.tab.octave + octave) * octaveInfo.size);

					// trigger the note
					await this.triggerNote(n, 1);
					this.scmap[name] = n;

				} else if(this.scmap[name]){
					// release the note and remove scmap reference
					await this.releaseNote(this.scmap[name], 0);
					delete this.scmap[name];
				}

				return true;
			};

			// read the note and handle it
			switch(data.shift()?.toUpperCase()) {
				case "C":	return note(0);
				case "C#":	return note(1);
				case "D":	return note(2);
				case "D#":	return note(3);
				case "E":	return note(4);
				case "F":	return note(5);
				case "F#":	return note(6);
				case "G":	return note(7);
				case "G#":	return note(8);
				case "A":	return note(9);
				case "A#":	return note(10);
				case "B":	return note(11);
			}

			// note not found
			return false;
		}

		// helper function to process special note
		const specialNote = (note:number) => {
			if(state) {
				return this.triggerNote(note, 1);

			} else {
				return this.releaseNote(note, 0);
			}
		};

		// process the shortcut
		switch(data.shift()?.toLowerCase()) {
			case "rest":		return specialNote(Note.Rest);
			case "cut":			return specialNote(Note.Cut);
			case "octave0":		return octave(data, 0);
			case "octave1":		return octave(data, 1);
			case "octave2":		return octave(data, 2);
		}

		return false;
	}

	/**
	 * Helper function to get the ID of the currently selected element in single selection
	 */
	private getCurrentElementId() {
		return this.parent.channelInfo[this.parent.selectionManager.single.channel].elements[this.parent.selectionManager.single.element];
	}

	/**
	 * Helper function to get the currently active pattern cell
	 */
	private getCurrentPatternCell(): null|[ number, PatternData, PatternCell, ] {
		// load the current channel
		const ch = this.parent.selectionManager.single.channel;

		// get the real pattern number
		const rp = this.parent.tab.matrix.get(ch, this.parent.selectionManager.single.pattern);

		if(typeof rp !== "number") {
			return null;
		}

		// load the pattern data based on pattern number
		const pd = this.parent.tab.matrix.patterns[ch][rp];

		if(!pd) {
			return null;
		}

		// find the cell that we're targeting
		const cell = pd.cells[this.parent.selectionManager.single.row];
		return !cell ? null : [ rp, pd, cell, ];
	}

	/**
	 * Helper function to update the current data row
	 */
	private updateCurrentRow(pattern:number) {
		const sel = this.parent.selectionManager.single;
		return this.parent.scrollManager.updateDataRow(pattern, sel.row, sel.channel);
	}

	/**
	 * Trigger a note at a certain velocity
	 *
	 * @param note The note ID to trigger
	 * @param velocity The velocity to trigger the note with, from 0 to 1.0.
	 * @returns boolean indicatin whether the note was triggered
	 */
	public async triggerNote(note:number, velocity:number):Promise<boolean> {
		// check if this note exists
		const freq = (await this.parent.tab.getNotes(this.parent.tab.selectedChannel.type)).notes[note]?.frequency;

		if(typeof freq === "number"){
			// note exists, check how to handle it
			if(!isNaN(freq)) {
				// can play on piano
				await eventNoteOn(this.parent.tab.selectedChannelId, note, velocity);
			}

			// if in record mode, check whether to place this note
			if(this.parent.tab.recordMode && this.getCurrentElementId() === 0) {
				const cd = this.getCurrentPatternCell();

				if(cd) {
					// save the note
					cd[2].note = note;
					cd[1].edited = true;

					// reload this row
					await this.updateCurrentRow(cd[0]);

					// project is dirty now
					this.parent.tab.project.dirty();
				}
			}
			return true;
		}

		return false;
	}

	/**
	 * Release a note
	 *
	 * @param note The note ID to release
	 * @param velocity The velocity to release the note with, from 0 to 1.0.
	 * @returns boolean indicatin whether the note was released
	 */
	public async releaseNote(note:number, velocity:number):Promise<boolean> {
		// check if this note exists
		const freq = (await this.parent.tab.getNotes(this.parent.tab.selectedChannel.type)).notes[note]?.frequency;

		if(typeof freq === "number"){
			// note exists, check how to handle it
			if(!isNaN(freq)) {
				// can release on piano
				await eventNoteOff(this.parent.tab.selectedChannelId, note, velocity);
			}

			return true;
		}

		return false;
	}

	/**
	 * Helper function to get relative note to start of current octave, mainly for MIDI devices.
	 *
	 * @param offset The note offset from the start of current octave
	 * @returns the translated note
	 */
	public async getRelativeNote(offset:number): Promise<number> {
		const octave = (await this.parent.tab.getNotes(this.parent.tab.selectedChannel.type)).octave;
		return ((this.parent.tab.octave + 1) * octave.size) + octave.C0 + offset;
	}
}

let _shortcut:undefined|PatternEditorShortcuts;

/*
 * Store a translation table of MIDI notes -> driver notes. This allows the octave to change without disturbing the MIDI note.
 */
const keys:number[] = Array(128);

/**
 * Helper event listener for the MidiNoteOn event, so that the piano can receive notes from MIDI devices
 */
ZorroEvent.addListener(ZorroEventEnum.MidiNoteOn, async(event:ZorroEventObject, channel:number, note:number, velocity:number) => {
	if(_shortcut) {
		// get the relative note to trigger
		const rn = await _shortcut.getRelativeNote(note - 60);

		// attempt to trigger the note
		if(await _shortcut.triggerNote(rn, velocity)) {
			keys[note] = rn;
		}
	}
});

/**
 * Helper event listener for the MidiNoteOff event, so that the piano can receive notes from MIDI devices
 */
ZorroEvent.addListener(ZorroEventEnum.MidiNoteOff, async(event:ZorroEventObject, channel:number, note:number, velocity:number) => {
	if(_shortcut) {
		// attempt to release the note
		if(await _shortcut.releaseNote(keys[note], velocity)) {
			keys[note] = 0;
		}
	}
});
