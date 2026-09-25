import { Redirect } from 'expo-router';

// Cold start lands on "/". Until the auth/registration branching exists
// (Task 10), forward straight into the tab shell.
export default function Index() {
  return <Redirect href="/home" />;
}
