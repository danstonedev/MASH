const sql = require('mssql');

module.exports = async function (context, req) {
    context.log('PUT sessions endpoint called');

    const sessionId = req.query.id || (req.body && req.body.id);
    const updates = req.body;

    if (!sessionId) {
        context.res = {
            status: 400,
            body: { error: "Please provide a session id" }
        };
        return;
    }

    const connectionString = process.env.SQL_CONNECTION_STRING;

    if (!connectionString) {
        // Mock response for dev
        context.log(`Mock updating session: ${sessionId}`);
        context.res = {
            status: 200,
            body: { message: "Session updated (mock)", id: sessionId, updates }
        };
        return;
    }

    try {
        await sql.connect(connectionString);

        // Build dynamic update query based on provided fields and available schema columns.
        // This preserves richer session metadata when optional columns exist, while staying
        // compatible with minimal schemas.
        const colReq = new sql.Request();
        const colResult = await colReq.query(`
            SELECT COLUMN_NAME
            FROM INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_NAME = 'Sessions'
        `);
        const sessionColumns = new Set(
            (colResult.recordset || []).map((r) => String(r.COLUMN_NAME || '').toLowerCase())
        );

        const updateFields = [];
        const request = new sql.Request();
        request.input('id', sql.VarChar, sessionId);
        const skippedFields = [];

        const addField = (inputKey, columnName, type, transform) => {
            if (updates[inputKey] === undefined) return;
            if (!sessionColumns.has(columnName.toLowerCase())) {
                skippedFields.push(inputKey);
                return;
            }
            const param = inputKey;
            const value = transform ? transform(updates[inputKey]) : updates[inputKey];
            updateFields.push(`${columnName} = @${param}`);
            request.input(param, type, value);
        };

        addField('name', 'Name', sql.VarChar);
        addField('endTime', 'EndTime', sql.BigInt);
        addField('sensorCount', 'SensorCount', sql.Int);
        addField('sampleRate', 'SampleRate', sql.Int);
        addField('athleteId', 'AthleteId', sql.VarChar);
        addField('activityType', 'ActivityType', sql.VarChar);
        addField('notes', 'Notes', sql.NVarChar(sql.MAX));
        addField('metrics', 'MetricsJson', sql.NVarChar(sql.MAX), (v) => JSON.stringify(v));
        addField('sensorMapping', 'SensorMappingJson', sql.NVarChar(sql.MAX), (v) => JSON.stringify(v));
        addField('calibrationOffsets', 'CalibrationOffsetsJson', sql.NVarChar(sql.MAX), (v) => JSON.stringify(v));
        addField('tareStates', 'TareStatesJson', sql.NVarChar(sql.MAX), (v) => JSON.stringify(v));
        addField('firmwareVersion', 'FirmwareVersion', sql.VarChar);
        addField('deviceName', 'DeviceName', sql.VarChar);
        addField('tags', 'TagsJson', sql.NVarChar(sql.MAX), (v) => JSON.stringify(v));
        addField('environmentalConditions', 'EnvironmentalConditionsJson', sql.NVarChar(sql.MAX), (v) => JSON.stringify(v));

        if (updateFields.length === 0) {
            context.res = {
                status: 400,
                body: {
                    error: "No valid update fields provided",
                    skippedFields,
                }
            };
            return;
        }

        const query = `UPDATE Sessions SET ${updateFields.join(', ')} WHERE Id = @id`;
        const result = await request.query(query);

        if (result.rowsAffected[0] === 0) {
            context.res = {
                status: 404,
                body: { error: "Session not found" }
            };
            return;
        }

        context.res = {
            status: 200,
            body: { message: "Session updated", id: sessionId, skippedFields }
        };
    } catch (err) {
        context.log.error(err);
        context.res = {
            status: 500,
            body: { error: "Error updating database" }
        };
    }
}
