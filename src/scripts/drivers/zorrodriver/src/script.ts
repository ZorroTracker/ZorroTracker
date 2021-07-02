import { Channel, ChannelType, Driver, DriverConfig, NoteData, NoteReturnType } from "../../../../api/driver";
import { Chip, PSGCMD } from "../../../../api/chip";
import { DefaultOctave, DefaultOctaveSharp, Note, OctaveSize } from "../../../../api/notes";

export default class implements Driver {
	private chip:Chip|undefined;
	private NoteFM:NoteReturnType;
	private NotePSG:NoteReturnType;

	constructor() {
		// process PSG notes
		this.NotePSG = this.noteGen((note: number) => {
			const xo = (OctaveSize * 7) + Note.C0;

			if(note < Note.C0) {
				// negative octaves
				return undefined;

			} else if(note >= xo) {
				// nB-1
				return [ 0xB, 0xA, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0, ][note - xo];
			}

			// positive octaves
			const ftable = this.frequencies[note - Note.C0 + (OctaveSize * 2)];
			return !ftable ? undefined : Math.min(0x3FF, Math.round(3579545 / (32 * ftable)) - 1);
		});

		// process FM notes
		this.NoteFM = this.noteGen((note: number) => {
			if(note < Note.C0) {
				// negative octaves
				const ftable = this.frequencies[note - Note.C0 + (OctaveSize * 4)];
				return Math.round((144 * ftable * 2**20 / 7670454) / 2 ** (4 - 1));

			} else if(note >= Note.C0 + (OctaveSize * 8)) {
				// invalid octaves
				return undefined;
			}

			// positive octaves
			const ftable = this.frequencies[(-Note.C0 + (OctaveSize * 4)) + (note % OctaveSize)];
			return (((note / OctaveSize) | 0) * 0x800) | Math.round((144 * ftable * 2**20 / 7670454) / 2 ** (4 - 1));
		});
	}

	public init(samplerate:number, config:DriverConfig|null, chip:Chip):void {
		this.chip = chip;
	}

	public reset():void {

	}

	public play():void {

	}

	public stop():void {

	}

	public buffer(initSamples: number, advance:(samples:number) => number):void {
		if(!this.chip) {
			throw new Error("chip is null");
		}
	}

	public getChannels(): Channel[] {
		return [
			{ name: "FM1", id: 0, type: ChannelType.YM2612FM, },
			{ name: "FM2", id: 1, type: ChannelType.YM2612FM, },
			{ name: "FM3", id: 2, type: ChannelType.YM2612FM, },
			{ name: "FM4", id: 3, type: ChannelType.YM2612FM, },
			{ name: "FM5", id: 4, type: ChannelType.YM2612FM, },
			{ name: "FM6", id: 5, type: ChannelType.YM2612FM, },
			{ name: "PCM1", id:10, type: ChannelType.YM2612DAC, },
			{ name: "PCM2", id:11, type: ChannelType.YM2612DAC, },
			{ name: "PSG1", id: 6, type: ChannelType.YM7101PSG, },
			{ name: "PSG2", id: 7, type: ChannelType.YM7101PSG, },
			{ name: "PSG3", id: 8, type: ChannelType.YM7101PSG, },
			{ name: "PSG4", id: 9, type: ChannelType.YM7101PSG, },
		];
	}

	public muteChannel(id:number, state:boolean): boolean {
		if(id < 6) {
			// FM
			this.chip.muteYM(id, state);
			return true;

		} else if(id < 10) {
			// PSG
			this.chip.mutePSG(id - 6, state);
			return true;

		} else if(id < 12) {
			// DAC
			return false;
		}

		return false;
	}

	public enableChannel():boolean {
		return true;
	}

	public disableChannel():boolean {
		return true;
	}

	/**
	 * Function to get the frequency table based on channel type
	 *
	 * @param type The channel type to inspect
	 * @returns The table containing note info
	 */
	public notes(type:ChannelType): NoteReturnType {
		switch(type) {
			case ChannelType.YM2612FM:	return this.NoteFM;
			case ChannelType.YM7101PSG:	return this.NotePSG;
			case ChannelType.YM2612DAC:	return undefined;
			case ChannelType.TimerA:	return undefined;
		}

		return undefined;
	}

	/**
	 * Function to get the frequency table based on channel type
	 *
	 * @param type The channel type to inspect
	 * @returns The table containing note info
	 */
	private noteGen(func:(note: number) => number|undefined): NoteReturnType {
		// prepare some variables
		const ret = Array<NoteData>(256);

		// prepare some values
		ret[0] = { frequency: 0xFFFE, name: "", sharp: "", };
		ret[1] = { frequency: 0xFFFF, name: "=", sharp: "", };

		// filler
		ret[2] = { frequency: undefined, name: "", sharp: "", };
		ret[3] = { frequency: undefined, name: "", sharp: "", };

		// function defined, start filling the table
		for(let n = Note.First;n < Note.Last; n++) {
			// load frequency
			const freq = func(n);

			// calculate the offset inside of an octave
			const op = (n - Note.First) % OctaveSize;

			// replace the note data with this
			ret[n] = {
				name: DefaultOctave[op] +"\u2060"+ (Math.floor((n - Note.C0) / OctaveSize)),
				sharp: DefaultOctaveSharp[op],
				frequency: freq,
			};
		}

		return ret;
	}

	/**
	 * Trigger a note via the piano. The channel is a mere suggestion for the driver to know how to handle this.
	 *
	 * @param note The ID of the note to trigger
	 * @param velocity A value between 0 and 1, representing the velocity of the note. 0 = mute
	 * @param channel The ID of the channel to trigger the note on
	 * @returns Whether the note was triggered
	 */
	public pianoTrigger(note:number, velocity:number, channel:number): boolean {
		// pretend this is PSG
		const data = this.NotePSG[note];

		// check for invalid notes
		if(typeof data?.frequency !== "number") {
			return false;
		}

		this.pianoNotes[channel] = note;

		// enable PSG frequency
		this.chip.writePSG(PSGCMD.FREQ | PSGCMD.PSG3 | (data.frequency & 0xF));
		this.chip.writePSG((data.frequency & 0x3F0) >> 4);

		// enable PSG volume
		this.chip.writePSG(PSGCMD.VOLUME | PSGCMD.PSG3 | this.PSGVol[(this.PSGVol.length - 1 - Math.floor(velocity * (this.PSGVol.length - 1)))]);
		return true;
	}

	/**
	 * Mapping piano notes to active channel. This helps easily release notes
	 */
	private pianoNotes:{ [key:number]: number } = {};

	/**
	 * PSG volume LUT
	 */
	private PSGVol = [ 0, 0, 0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 5, 5, 5, 6, 6, 7, 7, 8, 9, 0xA, 0xB, 0xC, 0xD, 0xE, ];

	/**
	 * Release a note via the piano.
	 *
	 * @param note The ID of the note to release
	 * @returns Whether the note was release
	 */
	public pianoRelease(note:number): boolean {
		// scan for this note
		for(const channel of Object.keys(this.pianoNotes)) {
			if(this.pianoNotes[channel] === note) {
				// release note
				this.chip.writePSG(PSGCMD.VOLUME | PSGCMD.PSG3 | 0xF);
				return true;
			}
		}

		// found nothing
		return true;
	}

	/**
	 * The list of frequencies to recreate
	 */
	private frequencies = [
		16.35, 17.32, 18.35, 19.45, 20.60, 21.83, 23.12, 24.50, 25.96, 27.50, 29.14, 30.87,
		32.70, 34.65, 36.71, 38.89, 41.20, 43.65, 46.25, 49.00, 51.91, 55.00, 58.27, 61.74,
		65.41, 69.30, 73.42, 77.78, 82.41, 87.31, 92.50, 98.00, 103.83, 110.00, 116.54, 123.47,
		130.81, 138.59, 146.83, 155.56, 164.81, 174.61, 185.00, 196.00, 207.65, 220.00, 233.08, 246.94,

		261.63, 277.18, 293.66, 311.13, 329.63, 349.23, 369.99, 392.00, 415.30, 440.00, 466.16, 493.88,

		523.25, 554.37, 587.33, 622.25, 659.25, 698.46, 739.99, 783.99, 830.61, 880.00, 932.33, 987.77,
		1046.50, 1108.73, 1174.66, 1244.51, 1318.51, 1396.91, 1479.98, 1567.98, 1661.22, 1760.00, 1864.66, 1975.53,
		2093.00, 2217.46, 2349.32, 2489.02, 2637.02, 2793.83, 2959.96, 3135.96, 3322.44, 3520.00, 3729.31, 3951.07,
		4186.01, 4434.92, 4698.63, 4978.03, 5274.04, 5587.65, 5919.91, 6271.93, 6644.88, 7040.00, 7458.62, 7902.13,
	];
}
