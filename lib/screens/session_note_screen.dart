import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

class SessionNoteScreen extends StatefulWidget {
  final String clientId;
  final String clientName;

  const SessionNoteScreen({
    super.key,
    required this.clientId,
    required this.clientName,
  });

  @override
  State<SessionNoteScreen> createState() => _SessionNoteScreenState();
}

class _SessionNoteScreenState extends State<SessionNoteScreen> {
  final _supabase = Supabase.instance.client;
  int _currentStep = 0;
  bool _isSaving = false;

  // Step 1 – Barrier Analysis
  bool _barrierMotor = false;
  bool _barrierLinguistic = false;
  bool _barrierCognitive = false;
  bool _barrierSensory = false;
  bool _barrierEnvironmental = false;
  bool _barrierMotivational = false;
  bool _barrierDeviceAccess = false;

  // Step 2 – Session Goal
  final _targetBehaviourController = TextEditingController();
  final _conditionController = TextEditingController();
  final _criterionController = TextEditingController();

  // Step 3 – Activity
  final _activityNameController = TextEditingController();
  final _activityRationaleController = TextEditingController();

  // Step 4 – Prompt Hierarchy
  String _promptApproach = 'most_to_least';
  int _promptLevelUsed = 1;

  // Step 5 – During Session
  final _attemptsController = TextEditingController();
  final _independentResponsesController = TextEditingController();
  final _promptedResponsesController = TextEditingController();
  String _clientAffect = 'regulated';

  // Step 6 – Post Session
  String _goalMet = 'yes';
  final _homeProgrammeController = TextEditingController();
  final _nextSessionFocusController = TextEditingController();

  static const _stepLabels = [
    'Barriers',
    'Goal',
    'Activity',
    'Prompts',
    'Session',
    'Post',
  ];

  static const _promptDescriptions = {
    1: 'Independent',
    2: 'Gesture / Visual',
    3: 'Verbal',
    4: 'Model',
    5: 'Partial Physical',
    6: 'Full Physical',
  };

  @override
  void dispose() {
    _targetBehaviourController.dispose();
    _conditionController.dispose();
    _criterionController.dispose();
    _activityNameController.dispose();
    _activityRationaleController.dispose();
    _attemptsController.dispose();
    _independentResponsesController.dispose();
    _promptedResponsesController.dispose();
    _homeProgrammeController.dispose();
    _nextSessionFocusController.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    setState(() => _isSaving = true);
    try {
      await _supabase.from('sessions').insert({
        'client_id': widget.clientId,
        'date': DateTime.now().toIso8601String().substring(0, 10),
        'barrier_motor': _barrierMotor,
        'barrier_linguistic': _barrierLinguistic,
        'barrier_cognitive': _barrierCognitive,
        'barrier_sensory': _barrierSensory,
        'barrier_environmental': _barrierEnvironmental,
        'barrier_motivational': _barrierMotivational,
        'barrier_device_access': _barrierDeviceAccess,
        'target_behaviour': _targetBehaviourController.text.trim(),
        'condition': _conditionController.text.trim(),
        'criterion': _criterionController.text.trim(),
        'activity_name': _activityNameController.text.trim(),
        'activity_rationale': _activityRationaleController.text.trim(),
        'prompt_approach': _promptApproach,
        'prompt_level_used': _promptLevelUsed,
        'attempts': int.tryParse(_attemptsController.text) ?? 0,
        'independent_responses':
            int.tryParse(_independentResponsesController.text) ?? 0,
        'prompted_responses':
            int.tryParse(_promptedResponsesController.text) ?? 0,
        'client_affect': _clientAffect,
        'goal_met': _goalMet,
        'home_programme': _homeProgrammeController.text.trim(),
        'next_session_focus': _nextSessionFocusController.text.trim(),
      });
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('Session saved successfully'),
            backgroundColor: Colors.teal,
          ),
        );
        Navigator.pop(context, true);
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Error saving session: $e')),
        );
      }
    } finally {
      if (mounted) setState(() => _isSaving = false);
    }
  }

  // ── Build ────────────────────────────────────────────────────────────────────

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text('Session – ${widget.clientName}'),
        backgroundColor: Colors.teal,
        foregroundColor: Colors.white,
      ),
      body: Column(
        children: [
          _buildStepIndicator(),
          Expanded(
            child: SingleChildScrollView(
              padding: const EdgeInsets.fromLTRB(20, 24, 20, 8),
              child: _buildCurrentStep(),
            ),
          ),
          _buildNavBar(),
        ],
      ),
    );
  }

  // ── Step Indicator ───────────────────────────────────────────────────────────

  Widget _buildStepIndicator() {
    return Container(
      padding: const EdgeInsets.symmetric(vertical: 14, horizontal: 12),
      color: Colors.teal.shade50,
      child: Row(
        children: List.generate(_stepLabels.length * 2 - 1, (i) {
          if (i.isOdd) {
            final stepBefore = i ~/ 2;
            return Expanded(
              child: Container(
                height: 2,
                color: stepBefore < _currentStep
                    ? Colors.teal
                    : Colors.grey.shade300,
              ),
            );
          }
          final idx = i ~/ 2;
          final done = idx < _currentStep;
          final active = idx == _currentStep;
          return Column(
            children: [
              Container(
                width: 30,
                height: 30,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  color: done || active ? Colors.teal : Colors.grey.shade200,
                  border: Border.all(
                    color:
                        done || active ? Colors.teal : Colors.grey.shade400,
                    width: 1.5,
                  ),
                ),
                child: Center(
                  child: done
                      ? const Icon(Icons.check, color: Colors.white, size: 14)
                      : Text(
                          '${idx + 1}',
                          style: TextStyle(
                            color: active
                                ? Colors.white
                                : Colors.grey.shade500,
                            fontSize: 12,
                            fontWeight: FontWeight.bold,
                          ),
                        ),
                ),
              ),
              const SizedBox(height: 4),
              Text(
                _stepLabels[idx],
                style: TextStyle(
                  fontSize: 9,
                  color: done || active
                      ? Colors.teal.shade700
                      : Colors.grey.shade400,
                  fontWeight:
                      active ? FontWeight.w700 : FontWeight.normal,
                ),
              ),
            ],
          );
        }),
      ),
    );
  }

  // ── Step Router ──────────────────────────────────────────────────────────────

  Widget _buildCurrentStep() {
    switch (_currentStep) {
      case 0:
        return _buildStep1();
      case 1:
        return _buildStep2();
      case 2:
        return _buildStep3();
      case 3:
        return _buildStep4();
      case 4:
        return _buildStep5();
      case 5:
        return _buildStep6();
      default:
        return const SizedBox.shrink();
    }
  }

  // ── Step 1 – Barrier Analysis ────────────────────────────────────────────────

  Widget _buildStep1() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        _stepHeader(
          'Barrier Analysis',
          'Which barriers are present for this client today?',
        ),
        const SizedBox(height: 12),
        _barrierTile(
          'Motor',
          _barrierMotor,
          (v) => setState(() => _barrierMotor = v!),
        ),
        _barrierTile(
          'Linguistic',
          _barrierLinguistic,
          (v) => setState(() => _barrierLinguistic = v!),
        ),
        _barrierTile(
          'Cognitive',
          _barrierCognitive,
          (v) => setState(() => _barrierCognitive = v!),
        ),
        _barrierTile(
          'Sensory',
          _barrierSensory,
          (v) => setState(() => _barrierSensory = v!),
        ),
        _barrierTile(
          'Environmental',
          _barrierEnvironmental,
          (v) => setState(() => _barrierEnvironmental = v!),
        ),
        _barrierTile(
          'Motivational',
          _barrierMotivational,
          (v) => setState(() => _barrierMotivational = v!),
        ),
        _barrierTile(
          'Device Access',
          _barrierDeviceAccess,
          (v) => setState(() => _barrierDeviceAccess = v!),
        ),
      ],
    );
  }

  Widget _barrierTile(
      String label, bool value, ValueChanged<bool?> onChanged) {
    return CheckboxListTile(
      title: Text(label, style: const TextStyle(fontSize: 15)),
      value: value,
      onChanged: onChanged,
      activeColor: Colors.teal,
      controlAffinity: ListTileControlAffinity.leading,
      contentPadding: const EdgeInsets.symmetric(horizontal: 0),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
    );
  }

  // ── Step 2 – Session Goal ────────────────────────────────────────────────────

  Widget _buildStep2() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        _stepHeader(
          'Session Goal',
          'Define the measurable goal for this session.',
        ),
        const SizedBox(height: 20),
        _textField(
          controller: _targetBehaviourController,
          label: 'Target Behaviour',
          hint: 'e.g. Request preferred items using core vocabulary',
          maxLines: 2,
        ),
        const SizedBox(height: 16),
        _textField(
          controller: _conditionController,
          label: 'Condition',
          hint: 'e.g. During structured play with 3 objects present',
        ),
        const SizedBox(height: 16),
        _textField(
          controller: _criterionController,
          label: 'Criterion',
          hint: 'e.g. 4 out of 5 trials across 3 sessions',
        ),
      ],
    );
  }

  // ── Step 3 – Activity ────────────────────────────────────────────────────────

  Widget _buildStep3() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        _stepHeader(
          'Activity',
          'Describe the activity used in this session.',
        ),
        const SizedBox(height: 20),
        _textField(
          controller: _activityNameController,
          label: 'Activity Name',
          hint: 'e.g. Snack time, cause & effect toy play',
        ),
        const SizedBox(height: 16),
        _textField(
          controller: _activityRationaleController,
          label: 'Rationale',
          hint: 'Why this activity was selected for the client',
          maxLines: 3,
        ),
      ],
    );
  }

  // ── Step 4 – Prompt Hierarchy ────────────────────────────────────────────────

  Widget _buildStep4() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        _stepHeader(
          'Prompt Hierarchy',
          'Select the prompting approach and the level used.',
        ),
        const SizedBox(height: 20),
        DropdownButtonFormField<String>(
          value: _promptApproach,
          decoration: _inputDecoration('Prompting Approach'),
          items: const [
            DropdownMenuItem(
              value: 'most_to_least',
              child: Text('Most to Least'),
            ),
            DropdownMenuItem(
              value: 'least_to_most',
              child: Text('Least to Most'),
            ),
          ],
          onChanged: (v) => setState(() => _promptApproach = v!),
        ),
        const SizedBox(height: 28),
        Text(
          'Prompt Level Used',
          style: TextStyle(
            fontSize: 13,
            fontWeight: FontWeight.w600,
            color: Colors.grey.shade700,
          ),
        ),
        const SizedBox(height: 10),
        Container(
          padding: const EdgeInsets.fromLTRB(16, 12, 16, 8),
          decoration: BoxDecoration(
            border: Border.all(color: Colors.teal.shade200),
            borderRadius: BorderRadius.circular(12),
            color: Colors.teal.shade50,
          ),
          child: Column(
            children: [
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  Text(
                    'Level $_promptLevelUsed',
                    style: const TextStyle(
                      fontSize: 20,
                      fontWeight: FontWeight.bold,
                      color: Colors.teal,
                    ),
                  ),
                  Text(
                    _promptDescriptions[_promptLevelUsed] ?? '',
                    style: TextStyle(
                      fontSize: 14,
                      color: Colors.teal.shade700,
                      fontWeight: FontWeight.w500,
                    ),
                  ),
                ],
              ),
              Slider(
                value: _promptLevelUsed.toDouble(),
                min: 1,
                max: 6,
                divisions: 5,
                activeColor: Colors.teal,
                inactiveColor: Colors.teal.shade100,
                label: '$_promptLevelUsed',
                onChanged: (v) =>
                    setState(() => _promptLevelUsed = v.round()),
              ),
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: List.generate(
                  6,
                  (i) => Text(
                    '${i + 1}',
                    style: TextStyle(
                      fontSize: 11,
                      color: _promptLevelUsed == i + 1
                          ? Colors.teal
                          : Colors.grey.shade400,
                      fontWeight: _promptLevelUsed == i + 1
                          ? FontWeight.bold
                          : FontWeight.normal,
                    ),
                  ),
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: 20),
        ..._promptDescriptions.entries.map(
          (e) => Padding(
            padding: const EdgeInsets.symmetric(vertical: 4),
            child: Row(
              children: [
                Container(
                  width: 24,
                  height: 24,
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    color: e.key == _promptLevelUsed
                        ? Colors.teal
                        : Colors.grey.shade200,
                  ),
                  child: Center(
                    child: Text(
                      '${e.key}',
                      style: TextStyle(
                        fontSize: 11,
                        fontWeight: FontWeight.bold,
                        color: e.key == _promptLevelUsed
                            ? Colors.white
                            : Colors.grey.shade500,
                      ),
                    ),
                  ),
                ),
                const SizedBox(width: 12),
                Text(
                  e.value,
                  style: TextStyle(
                    fontSize: 14,
                    color: e.key == _promptLevelUsed
                        ? Colors.teal.shade800
                        : Colors.grey.shade600,
                    fontWeight: e.key == _promptLevelUsed
                        ? FontWeight.w600
                        : FontWeight.normal,
                  ),
                ),
              ],
            ),
          ),
        ),
      ],
    );
  }

  // ── Step 5 – During Session ──────────────────────────────────────────────────

  Widget _buildStep5() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        _stepHeader(
          'During Session',
          'Record trial data and client affect.',
        ),
        const SizedBox(height: 20),
        _numberField(
          controller: _attemptsController,
          label: 'Total Attempts',
          hint: '0',
        ),
        const SizedBox(height: 16),
        _numberField(
          controller: _independentResponsesController,
          label: 'Independent Responses',
          hint: '0',
        ),
        const SizedBox(height: 16),
        _numberField(
          controller: _promptedResponsesController,
          label: 'Prompted Responses',
          hint: '0',
        ),
        const SizedBox(height: 20),
        DropdownButtonFormField<String>(
          value: _clientAffect,
          decoration: _inputDecoration('Client Affect'),
          items: const [
            DropdownMenuItem(value: 'regulated', child: Text('Regulated')),
            DropdownMenuItem(
              value: 'dysregulated',
              child: Text('Dysregulated'),
            ),
            DropdownMenuItem(value: 'variable', child: Text('Variable')),
          ],
          onChanged: (v) => setState(() => _clientAffect = v!),
        ),
      ],
    );
  }

  // ── Step 6 – Post Session ────────────────────────────────────────────────────

  Widget _buildStep6() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        _stepHeader(
          'Post Session',
          'Summarise outcomes and plan next steps.',
        ),
        const SizedBox(height: 20),
        DropdownButtonFormField<String>(
          value: _goalMet,
          decoration: _inputDecoration('Goal Met?'),
          items: const [
            DropdownMenuItem(value: 'yes', child: Text('Yes')),
            DropdownMenuItem(value: 'partially', child: Text('Partially')),
            DropdownMenuItem(value: 'not_yet', child: Text('Not Yet')),
          ],
          onChanged: (v) => setState(() => _goalMet = v!),
        ),
        const SizedBox(height: 16),
        _textField(
          controller: _homeProgrammeController,
          label: 'Home Programme',
          hint: 'Recommendations for carers to carry over at home',
          maxLines: 3,
        ),
        const SizedBox(height: 16),
        _textField(
          controller: _nextSessionFocusController,
          label: 'Next Session Focus',
          hint: 'What to prioritise in the next session',
          maxLines: 2,
        ),
        const SizedBox(height: 32),
        SizedBox(
          width: double.infinity,
          child: FilledButton(
            onPressed: _isSaving ? null : _save,
            style: FilledButton.styleFrom(
              backgroundColor: Colors.teal,
              padding: const EdgeInsets.symmetric(vertical: 16),
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(12),
              ),
            ),
            child: _isSaving
                ? const SizedBox(
                    width: 20,
                    height: 20,
                    child: CircularProgressIndicator(
                      color: Colors.white,
                      strokeWidth: 2,
                    ),
                  )
                : const Text(
                    'Save Session',
                    style: TextStyle(
                      fontSize: 16,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
          ),
        ),
        const SizedBox(height: 16),
      ],
    );
  }

  // ── Navigation Bar ───────────────────────────────────────────────────────────

  Widget _buildNavBar() {
    return Container(
      padding: const EdgeInsets.fromLTRB(20, 12, 20, 20),
      decoration: BoxDecoration(
        color: Colors.white,
        border: Border(top: BorderSide(color: Colors.grey.shade200)),
      ),
      child: Row(
        children: [
          if (_currentStep > 0)
            Expanded(
              child: OutlinedButton(
                onPressed: () => setState(() => _currentStep--),
                style: OutlinedButton.styleFrom(
                  foregroundColor: Colors.teal,
                  side: const BorderSide(color: Colors.teal),
                  padding: const EdgeInsets.symmetric(vertical: 14),
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(10),
                  ),
                ),
                child: const Text('Back'),
              ),
            ),
          if (_currentStep > 0 && _currentStep < 5)
            const SizedBox(width: 12),
          if (_currentStep < 5)
            Expanded(
              child: FilledButton(
                onPressed: () => setState(() => _currentStep++),
                style: FilledButton.styleFrom(
                  backgroundColor: Colors.teal,
                  padding: const EdgeInsets.symmetric(vertical: 14),
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(10),
                  ),
                ),
                child: const Text(
                  'Next',
                  style: TextStyle(fontSize: 15),
                ),
              ),
            ),
        ],
      ),
    );
  }

  // ── Shared Helpers ───────────────────────────────────────────────────────────

  Widget _stepHeader(String title, String subtitle) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          title,
          style: const TextStyle(fontSize: 20, fontWeight: FontWeight.bold),
        ),
        const SizedBox(height: 4),
        Text(
          subtitle,
          style: TextStyle(fontSize: 14, color: Colors.grey.shade600),
        ),
      ],
    );
  }

  InputDecoration _inputDecoration(String label) {
    return InputDecoration(
      labelText: label,
      filled: true,
      fillColor: Colors.grey.shade50,
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(10),
        borderSide: BorderSide(color: Colors.grey.shade300),
      ),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(10),
        borderSide: BorderSide(color: Colors.grey.shade300),
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(10),
        borderSide: const BorderSide(color: Colors.teal, width: 2),
      ),
    );
  }

  Widget _textField({
    required TextEditingController controller,
    required String label,
    String? hint,
    int maxLines = 1,
  }) {
    return TextField(
      controller: controller,
      maxLines: maxLines,
      decoration: _inputDecoration(label).copyWith(hintText: hint),
    );
  }

  Widget _numberField({
    required TextEditingController controller,
    required String label,
    String? hint,
  }) {
    return TextField(
      controller: controller,
      keyboardType: TextInputType.number,
      inputFormatters: [FilteringTextInputFormatter.digitsOnly],
      decoration: _inputDecoration(label).copyWith(hintText: hint),
    );
  }
}
