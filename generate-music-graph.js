const tonal = require('tonal');
const neo4j = require('neo4j-driver').v1;
const Promise = require('bluebird');
const _ = require('lodash');

const driver = neo4j.driver(process.env.NEO4J_URL || 'bolt://localhost',
  neo4j.auth.basic(process.env.NEO4J_USER, process.env.NEO4J_PASSWORD));

let session = driver.session();

const tonics = [
  'A', 'A#', 'Bb', 'B', 'C',
  'D', 'D#', 'Eb', 'F', 'F#',
  'Gb', 'G', 'G#', 'Ab',
];

let queriesRun = 0;

const concurrency = { concurrency: 1 };

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

const initIndexes = (tx) =>
  Promise.map(indexes,
    idx => tx.run(`CREATE INDEX on ${idx}`),
    concurrency);

const withTx = promiseReturningFunction => () => {
  const tx = session.beginTransaction();

  return promiseReturningFunction(tx)
    .then(results => new Promise((resolve, reject) => {
      tx.commit()
        .subscribe({
          onCompleted: () => {
            console.log('tx commit complete');
            return resolve(results);
          },
          onError: (err) => reject(err),
        });
    }));
};

const runQueries = someFunction => () => {
  const queries = someFunction();
  console.log('Got ', queries.length, ' queries.  Running them now.');
  return withTx((tx) => Promise.map(queries, query => tx.run(query[0], query[1]), concurrency))();
};

const initChords = (tx) =>
  Promise.map(tonal.Chord.names(),
    chordName => tx.run('MERGE (c:Chord { name: $chordName })',
      { chordName }), concurrency);

const initNotes = (tx) =>
  Promise.map(tonal.Note.names(),
    tonic => tx.run(
      'MERGE (t:Tone { name: $tonic, chroma: $chroma, alternativeName: $alternativeName })',
      {
        tonic,
        chroma: tonal.Note.chroma(tonic),
        alternativeName: getAlternativeName(tonic),
      }), concurrency)

const chordIntervals = () =>
    _.flatten(tonal.Chord.names().map(chord => {
      const intervals = tonal.Chord.intervals(chord);
      return intervals.map(interval => [
          `MATCH (i:Interval { name: $interval })
          MATCH (c:Chord { name: $chord })
          MERGE (c)-[:contains]->(i)`,
          { interval, chord }
      ]);
    }));

const generateNoteDistances = () =>
  _.flatten(tonal.Note.names().map(note1 => {
    return tonal.Note.names().map(note2 => {
      const distance = tonal.Distance.interval(note1, note2);
      return [
        `MATCH (n1:Tone { name: $note1 })
         MATCH (n2:Tone { name: $note2 })
         MERGE (n1)-[:interval { distance: $distance }]->(n2)`,
        { note1, note2, distance },
      ];
    })
  }));

const initIntervals = (tx) =>
  Promise.map(tonal.Interval.names(), intervalName => {
    return tx.run('MERGE (i:Interval { name: $intervalName })', { intervalName });
  }, concurrency);

const initScales = (tx) =>
  Promise.map(tonal.Scale.names(), scaleName => {
    return tx.run('MERGE (s:Scale { name: $scaleName })', { scaleName });
  }, concurrency);

const initChordInstances = () =>
  _.flatten(tonal.chord.names().map(chord => {
    return tonics.map(tonic => {
      const chordInstance = `${tonic} ${chord}`;

      return [
        `MATCH (t:Tone { name: $tonic })
        MATCH (c:Chord { name: $chord })
        MERGE (chordInstance:ChordInstance { name: $chordInstance })
        MERGE (chordInstance)-[:instance_of]->(c)
        MERGE (chordInstance)-[:has_tonic]->(t)
        `,
        { chordInstance, chord, tonic }
      ];
    });
  }));

const initChordInstanceMappings = () => {
  const queries = [];

  // Unfortunately it's necessary to go through this double loop twice to ensure
  // all chord instances are created in various parallelism cases.
  tonal.chord.names().forEach(chord => {
    tonics.forEach(tonic => {
      const chordInstance = `${tonic} ${chord}`;
      const notes = tonal.Chord.notes(chordInstance);
      const intervals = tonal.Chord.intervals(chord);
      
      notes.forEach((note, idx) =>
        queries.push([
          `MATCH (ci:ChordInstance { name: $chordInstance })
          MATCH (n:Tone { name: $note })
          MERGE (n)-[:in { function: $interval }]->(ci)`,
          { 
            note: tonal.Note.simplify(note),
            chordInstance,
            interval: intervals[idx],
          },
        ]));

      intervals.forEach((interval, idx) => {        
        queries.push([
          `MATCH (i:Interval { name: $interval })
           MATCH (ci:ChordInstance { name: $chordInstance })
           MERGE (ci)-[:contains { instance: $note }]->(i)`,
          { interval, chordInstance, note: notes[idx] },
        ]);
      });
    });
  });

  return queries;
};

/**
 * For each tonic and scale type, create a scale instance (e.g. C major).
 * Map that scale instance to the tones and intervals it contains.
 */
const initScaleInstances = () => {
  const queries = [];

  tonal.scale.names().map(scaleName => {
    tonics.map(tonic => {
      const intervals = tonal.scale(scaleName);
      const scale = intervals.map(tonal.transpose(`${tonic}`));

      const scaleInstanceName = `${tonic} ${scaleName}`;

      const query = `
        MATCH (scale:Scale { name: $scaleName })
        MERGE (scaleInstance:ScaleInstance { name: $scaleInstanceName })
        MERGE (scaleInstance)-[:instance_of]->(scale)`;
      queries.push([query, { scaleName, scaleInstanceName }]);

      intervals.map(name => {
        queries.push([
          `MATCH (i:Interval { name: $name }) 
          MATCH (s:Scale { name: $scaleName })
          MERGE (s)-[:contains]->(i)`, { scaleName, name }
        ])
      });

      scale.map(note => {
        queries.push([
          `MATCH (n:Tone { name: $note })
          MATCH (si:ScaleInstance { name: $scaleInstanceName })
          MERGE (n)-[:in]->(si)
          `,
          { note: `${tonal.Note.simplify(note)}`, scaleInstanceName: `${scaleInstanceName}` }]);
      });
    });
  });

  return queries;
};
 
const debug = x => () => console.log(x);

return withTx(initIndexes)()
  .then(debug('scales'))
  .then(withTx(initScales))
  .then(debug('notes'))
  .then(withTx(initNotes))
  .then(debug('chords'))
  .then(withTx(initChords))
  .then(withTx(initIntervals))
  .then(runQueries(chordIntervals))
  .then(debug('init chord instances'))
  .then(runQueries(initChordInstances))
  .then(debug('generateNoteDistances'))
  .then(runQueries(generateNoteDistances))
  .then(runQueries(initScaleInstances))
  .then(runQueries(initChordInstanceMappings))
  .then(() => console.log('All done'))
  .catch(err => console.error(err))
  .finally(() => driver.close());

