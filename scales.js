const tonal = require('tonal');
const neo4j = require('neo4j-driver').v1;
const Promise = require('bluebird');

const driver = neo4j.driver(process.env.NEO4J_URL || 'bolt://localhost',
  neo4j.auth.basic(process.env.NEO4J_USER, process.env.NEO4J_PASSWORD));
const session = driver.session();

const tonics = [
  'A', 'A#', 'Bb', 'B', 'C',
  'D', 'D#', 'Eb', 'F', 'F#',
  'Gb', 'G', 'G#', 'Ab',
];

let queriesRun = 0;
const queriesAndParams = [];

const runQueryWithParams = qAndP => {
  queriesRun++;
  if (queriesRun % 50 === 0) {
    console.log('Run ', queriesRun, 'of ', queriesAndParams.length);
  }
  return session.run(qAndP[0], qAndP[1]);
}

const concurrency = { concurrency: 1 };

console.log('Creating scales and intervals...');

const indexes = [
  ':Interval(name)', 
  ':Tone(name)', 
  ':Scale(name)', 
  ':Chord(name)', 
  ':ChordInstance(name)',
  ':ScaleInstance(name)',
];

const twoWayAlternativeNames = {
  'C#': 'Db',
  'Db': 'C#',

  'D#': 'Eb',
  'Eb': 'D#',

  'F#': 'Gb',
  'Gb': 'F#',

  'G#': 'Ab',
  'Ab': 'G#',

  'A#': 'Bb',
  'Bb': 'A#',
};

const getAlternativeName = note =>
  twoWayAlternativeNames[note] || '';

const initIndexes = () =>
  Promise.map(indexes,
    idx => session.run(`CREATE INDEX on ${idx}`),
    concurrency);

const initChords = () =>
  Promise.map(tonal.Chord.names(),
    chordName => session.run('MERGE (c:Chord { name: $chordName })',
      { chordName }), concurrency);

const initNotes = () =>
  Promise.map(tonal.Note.names(),
    tonic => session.run(
      'MERGE (t:Tone { name: $tonic, chroma: $chroma, alternativeName: $alternativeName })',
      {
        tonic,
        chroma: tonal.Note.chroma(tonic),
        alternativeName: getAlternativeName(tonic),
      }), concurrency)

const chordIntervals = () =>
    Promise.map(tonal.Chord.names(),
    chord => {
      const intervals = tonal.Chord.intervals(chord);
      return Promise.map(intervals, 
        interval => session.run(
          `MATCH (i:Interval { name: $interval })
          MATCH (c:Chord { name: $chord })
          MERGE (c)-[:contains]->(i)`,
          { interval, chord }
        ), concurrency);
    }, { concurrency: 1 });

const generateNoteDistances = () => {
  tonal.Note.names().forEach(note1 => {
    tonal.Note.names().forEach(note2 => {
      const distance = tonal.Distance.interval(note1, note2);
      queriesAndParams.push([
        `MATCH (n1:Tone { name: $note1 })
         MATCH (n2:Tone { name: $note2 })
         MERGE (n1)-[:interval { distance: $distance }]->(n2)`,
        { note1, note2, distance },
      ]);
    })
  });
};

const initIntervals = () =>
  Promise.map(tonal.Interval.names(), intervalName => {
    return session.run('MERGE (i:Interval { name: $intervalName })', { intervalName });
  }, concurrency);

const initScales = () =>
  Promise.map(tonal.Scale.names(), scaleName => {
    return session.run('MERGE (s:Scale { name: $scaleName })', { scaleName });
  }, concurrency);

const initChordInstances = () => {
  tonal.chord.names().forEach(chord => {
    tonics.forEach(tonic => {
      const chordInstance = `${tonic} ${chord}`;
      const notes = tonal.Chord.notes(chordInstance);
      const intervals = tonal.Chord.intervals(chord);

      queriesAndParams.push([
        `MATCH (t:Tone { name: $tonic })
        MATCH (c:Chord { name: $chord })
        MERGE (chordInstance:ChordInstance { name: $chordInstance })
        MERGE (chordInstance)-[:instance_of]->(c)
        MERGE (chordInstance)-[:has_tonic]->(t)
        `,
        { chordInstance, chord, tonic }
      ]);
    });
  });

  // Unfortunately it's necessary to go through this double loop twice to ensure
  // all chord instances are created in various parallelism cases.
  tonal.chord.names().forEach(chord => {
    tonics.forEach(tonic => {
      const chordInstance = `${tonic} ${chord}`;
      const notes = tonal.Chord.notes(chordInstance);
      const intervals = tonal.Chord.intervals(chord);
      
      notes.forEach(note =>
        queriesAndParams.push([
          `MATCH (ci:ChordInstance { name: $chordInstance })
          MATCH (n:Tone { name: $note })
          MERGE (n)-[:in]->(ci)`,
          { note: tonal.Note.simplify(note), chordInstance },
        ]));

      intervals.forEach(interval =>
        queriesAndParams.push([
          `MATCH (i:Interval { name: $interval })
           MATCH (ci:ChordInstance { name: $chordInstance })
           MERGE (ci)-[:contains]->(i)`,
          { interval, chordInstance },
        ]));
    });
  });
};

/**
 * For each tonic and scale type, create a scale instance (e.g. C major).
 * Map that scale instance to the tones and intervals it contains.
 */
const initScaleInstances = () =>
  tonal.scale.names().map(scaleName => {
    tonics.map(tonic => {
      const intervals = tonal.scale(scaleName);
      const scale = intervals.map(tonal.transpose(`${tonic}`));

      const scaleInstanceName = `${tonic} ${scaleName}`;

      const query = `
        MATCH (scale:Scale { name: $scaleName })
        MERGE (scaleInstance:ScaleInstance { name: $scaleInstanceName })
        MERGE (scaleInstance)-[:instance_of]->(scale)`;
      queriesAndParams.push([query, { scaleName, scaleInstanceName }]);

      intervals.map(name => {
        queriesAndParams.push([
          `MATCH (i:Interval { name: $name }) 
          MATCH (s:Scale { name: $scaleName })
          MERGE (s)-[:contains]->(i)`, { scaleName, name }
        ])
      });

      scale.map(note => {
        queriesAndParams.push([
          `MATCH (n:Tone { name: $note })
          MATCH (si:ScaleInstance { name: $scaleInstanceName })
          MERGE (n)-[:in]->(si)
          `,
          { note: `${tonal.Note.simplify(note)}`, scaleInstanceName: `${scaleInstanceName}` }]);
      });
    });
  });

return initIndexes()
  .then(initScales)
  .then(initNotes)
  .then(initChords)
  .then(initIntervals)
  .then(chordIntervals)
  .then(generateNoteDistances)
  .then(initScaleInstances)
  .then(initChordInstances)
  .then(() =>
    // Run a huge pile queries, concurrency here is critical.
    Promise.map(queriesAndParams, qAndP => runQueryWithParams(qAndP), concurrency))
  .then(() => console.log('All done'))
  .catch(err => console.error(err))
  .finally(() => driver.close());

